package service

import (
	"context"
	"fmt"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/store"
)

// Systems (a Qawk addition, after Mender Orchestrator).
//
// A system is devices that work together and are updated together: a
// bowling centre with its lane computers (hd) and the terminals attached to
// them (st05, hyper). Its type -- Mender's topology -- lists its components,
// each a target query recognising its devices, and names the field a device
// carries to say which system it is in (metadata.center, set from the
// console; or an attribute the device reports). Every value of that field is
// one system.
//
// A manifest says what a system type should run: for each component a set
// and an order. A system deployment applies it to systems of the type, a few
// at a time. Inside each system the orders go one after the other, equal
// orders together -- the terminals first, then the lanes. A component
// already on its set is left alone. When one device of a system fails, the
// whole system is put back: every device of it the deployment updated gets
// again the set it ran before. The other systems go on; when more of them
// fail than the deployment allows, no new system is started.
//
// Mender runs this on a device of each system; Qawk runs it on the server,
// over devices that are ordinary hawkBit targets. Nothing on them changes.

const sysUser = "system:"

var keyFieldRE = regexp.MustCompile(`^(attribute|metadata)\.[A-Za-z0-9_.\-]+$`)

func errSys(msg string) error {
	return httpx.Custom(http.StatusConflict, "qawk.system.state", "qawk.SystemStateException", msg)
}

var anyTarget = func(*store.Args) []string { return nil }

// ------------------------------------------------------------ types

func (s *Service) SaveSystemType(ctx context.Context, user string, t model.SystemType) (int64, error) {
	t.Name = strings.TrimSpace(t.Name)
	if t.Name == "" {
		return 0, httpx.Validation("a system type needs a name")
	}
	if !keyFieldRE.MatchString(t.KeyField) {
		return 0, httpx.Validation("the system key is attribute.<key> or metadata.<key>, such as metadata.system")
	}
	if t.GroupField != "" && !keyFieldRE.MatchString(t.GroupField) {
		return 0, httpx.Validation("the group (centre) is attribute.<key> or metadata.<key>, such as attribute.centerid")
	}
	if len(t.Components) == 0 {
		return 0, httpx.Validation("a system type needs at least one component")
	}
	seen := map[string]bool{}
	for _, c := range t.Components {
		if strings.TrimSpace(c.ComponentType) == "" || seen[c.ComponentType] {
			return 0, httpx.Validation("each component needs a name of its own")
		}
		seen[c.ComponentType] = true
		if strings.TrimSpace(c.Match) == "" {
			return 0, httpx.Validation(c.ComponentType + ": say which devices it is, such as attribute.device_type==6hd")
		}
		if err := s.st.CheckQuery(c.Match); err != nil {
			return 0, err
		}
	}
	var id int64
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if t.ID != 0 {
			if _, err := s.st.SystemType(ctx, tx, t.ID); err != nil {
				return err
			}
		}
		var err error
		id, err = s.st.SaveSystemType(ctx, tx, user, now, t)
		return err
	})
	if err == nil {
		// who is in a system changed: the fleets must know at once
		if e := s.refreshMembers(ctx, true); e != nil {
			s.log.Warn("system members", "err", e)
		}
	}
	return id, err
}

var membersAt atomic.Int64

// refreshMembers records which targets are part of a system -- the fleets
// leave those to system deployments -- at most every 15 s, or now.
func (s *Service) refreshMembers(ctx context.Context, now bool) error {
	t0 := time.Now().UnixMilli()
	if !now && t0-membersAt.Load() < 15000 {
		return nil
	}
	membersAt.Store(t0)
	types, err := s.st.SystemTypes(ctx)
	if err != nil {
		return err
	}
	for _, t := range types {
		ids, keys, comps, err := s.members(ctx, t)
		if err != nil {
			return err
		}
		if err := s.st.SetSystemMembers(ctx, t.ID, ids, keys, comps); err != nil {
			return err
		}
	}
	return nil
}

// members finds the devices of every system of a type: target, system, component.
func (s *Service) members(ctx context.Context, t model.SystemType) (ids []int64, keys, comps []string, err error) {
	for _, c := range t.Components {
		m, err := s.st.Matching(ctx, s.st.DB(), c.Match, anyTarget)
		if err != nil {
			return nil, nil, nil, err
		}
		kv, err := s.st.KeyValues(ctx, m, t.KeyField)
		if err != nil {
			return nil, nil, nil, err
		}
		for _, id := range m {
			if k := kv[id]; k != "" {
				ids, keys, comps = append(ids, id), append(keys, k), append(comps, c.ComponentType)
			}
		}
	}
	return ids, keys, comps, nil
}

func (s *Service) DeleteSystemType(ctx context.Context, user string, id int64) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if _, err := s.st.SystemType(ctx, tx, id); err != nil {
			return err
		}
		return s.st.DeleteSystemType(ctx, tx, id)
	})
}

// SystemInstance is one system of a type, as the devices say.
type SystemInstance struct {
	Key        string
	Devices    int
	Components map[string]int
	Group      string  // its centre, when the type names a group field (what most of its devices say)
	FleetID    int64   // the fleet all its devices are in (0: none, or not all the same)
	Fleets     []int64 // every fleet its devices are in (0: none)
	Mixed      bool    // its devices are not all in the same fleet
}

// Systems lists the systems of a type: every value of its key among the
// devices of its components, with its centre and its channel.
func (s *Service) Systems(ctx context.Context, typeID int64) ([]SystemInstance, error) {
	t, err := s.st.SystemType(ctx, s.st.DB(), typeID)
	if err != nil {
		return nil, err
	}
	ids, keys, comps, err := s.members(ctx, t)
	if err != nil {
		return nil, err
	}
	fleetOf, err := s.st.TargetFleets(ctx, ids)
	if err != nil {
		return nil, err
	}
	// the centre: the type's own group field, or where the devices say their centre
	gf := t.GroupField
	if gf == "" {
		if gf, err = s.st.CentreField(ctx); err != nil {
			return nil, err
		}
	}
	groupOf, err := s.st.KeyValues(ctx, ids, gf)
	if err != nil {
		return nil, err
	}
	byKey := map[string]*SystemInstance{}
	votes := map[string]map[string]int{}
	fleets := map[string]map[int64]bool{}
	for i, id := range ids {
		k := keys[i]
		in := byKey[k]
		if in == nil {
			in = &SystemInstance{Key: k, Components: map[string]int{}}
			byKey[k], votes[k], fleets[k] = in, map[string]int{}, map[int64]bool{}
		}
		in.Components[comps[i]]++
		in.Devices++
		if g := groupOf[id]; g != "" {
			votes[k][g]++
		}
		fleets[k][fleetOf[id]] = true
	}
	out := make([]SystemInstance, 0, len(byKey))
	for k, in := range byKey {
		best := 0
		for g, n := range votes[k] {
			if n > best || (n == best && g < in.Group) {
				in.Group, best = g, n
			}
		}
		for f := range fleets[k] {
			in.Fleets = append(in.Fleets, f)
		}
		slices.Sort(in.Fleets)
		if len(in.Fleets) == 1 {
			in.FleetID = in.Fleets[0]
		} else {
			in.Mixed = true
		}
		out = append(out, *in)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out, nil
}

// ------------------------------------------------------------ manifests

func (s *Service) SaveManifest(ctx context.Context, user string, m model.Manifest) (int64, error) {
	m.Name = strings.TrimSpace(m.Name)
	if m.Name == "" {
		return 0, httpx.Validation("a manifest needs a name")
	}
	if len(m.Components) == 0 {
		return 0, httpx.Validation("a manifest names at least one component")
	}
	var id int64
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		t, err := s.st.SystemType(ctx, tx, m.SystemTypeID)
		if err != nil {
			return httpx.Validation(fmt.Sprintf("there is no system type %d", m.SystemTypeID))
		}
		has := map[string]bool{}
		for _, c := range t.Components {
			has[c.ComponentType] = true
		}
		seen := map[string]bool{}
		for _, c := range m.Components {
			if !has[c.ComponentType] {
				return httpx.Validation(fmt.Sprintf("%s has no component %s", t.Name, c.ComponentType))
			}
			if seen[c.ComponentType] {
				return httpx.Validation(c.ComponentType + " is named twice")
			}
			seen[c.ComponentType] = true
			if c.Order < 1 || c.Order > 1000 {
				return httpx.Validation(c.ComponentType + ": the order is 1 to 1000; lower goes first, equal together")
			}
			if _, err := s.st.DistributionSet(ctx, tx, c.DSID); err != nil {
				return httpx.Validation(fmt.Sprintf("%s: there is no distribution set %d", c.ComponentType, c.DSID))
			}
		}
		if m.ID != 0 {
			if _, err := s.st.Manifest(ctx, tx, m.ID); err != nil {
				return err
			}
		}
		id, err = s.st.SaveManifest(ctx, tx, user, now, m)
		return err
	})
	return id, err
}

func (s *Service) DeleteManifest(ctx context.Context, user string, id int64) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if _, err := s.st.Manifest(ctx, tx, id); err != nil {
			return err
		}
		return s.st.DeleteManifest(ctx, tx, id)
	})
}

// ------------------------------------------------------------ deployments

func (s *Service) CreateSystemDeployment(ctx context.Context, user string, d model.SystemDeployment) (int64, error) {
	d.Name = strings.TrimSpace(d.Name)
	if d.Name == "" {
		return 0, httpx.Validation("a system deployment needs a name")
	}
	if d.MaxParallel < 1 {
		d.MaxParallel = 1
	}
	if d.MaxFailed < 0 {
		return 0, httpx.Validation("maxFailed cannot be negative")
	}
	if d.ActionType == "" {
		d.ActionType = model.TypeForced
	}
	if d.ActionType != model.TypeForced && d.ActionType != model.TypeSoft {
		return 0, httpx.Validation("the type is forced or soft")
	}
	var id int64
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if _, err := s.st.Manifest(ctx, tx, d.ManifestID); err != nil {
			return httpx.Validation(fmt.Sprintf("there is no manifest %d", d.ManifestID))
		}
		if d.FleetID != nil {
			if _, err := s.st.Fleet(ctx, tx, *d.FleetID); err != nil {
				return httpx.Validation(fmt.Sprintf("there is no fleet %d", *d.FleetID))
			}
		}
		var err error
		id, err = s.st.CreateSystemDeployment(ctx, tx, user, now, d)
		return err
	})
	return id, err
}

func (s *Service) DeleteSystemDeployment(ctx context.Context, user string, id int64) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		d, err := s.st.SystemDeployment(ctx, tx, id)
		if err != nil {
			return err
		}
		if d.Status == model.SDRunning || d.Status == model.SDPaused {
			return errSys(fmt.Sprintf("%s is %s: abort it first", d.Name, d.Status))
		}
		return s.st.DeleteSystemDeployment(ctx, tx, id)
	})
}

// SystemDeploymentCommand is start, pause, resume or abort.
func (s *Service) SystemDeploymentCommand(ctx context.Context, user string, id int64, cmd, reason string) error {
	var d model.SystemDeployment
	var keys []string
	var note string
	if cmd == "start" {
		var err error
		if d, err = s.st.SystemDeployment(ctx, s.st.DB(), id); err != nil {
			return err
		}
		m, err := s.st.Manifest(ctx, s.st.DB(), d.ManifestID)
		if err != nil {
			return err
		}
		all, err := s.Systems(ctx, m.SystemTypeID)
		if err != nil {
			return err
		}
		have := map[string]SystemInstance{}
		for _, in := range all {
			have[in.Key] = in
		}
		// the channel: every device of the system in it; the centres: its own among them
		inScope := func(in SystemInstance) bool {
			if d.FleetID != nil && (in.Mixed || in.FleetID != *d.FleetID) {
				return false
			}
			return len(d.Groups) == 0 || slices.Contains(d.Groups, in.Group)
		}
		leftOut := 0
		if d.Systems == nil {
			for _, in := range all {
				switch {
				case inScope(in):
					keys = append(keys, in.Key)
				case d.FleetID != nil && in.Mixed && slices.Contains(in.Fleets, *d.FleetID) &&
					(len(d.Groups) == 0 || slices.Contains(d.Groups, in.Group)):
					leftOut++
				}
			}
		} else {
			for _, k := range d.Systems {
				in, ok := have[k]
				if !ok {
					return httpx.Validation(fmt.Sprintf("no device of %s says it is in system %q", m.SystemType, k))
				}
				if !inScope(in) {
					return httpx.Validation(fmt.Sprintf("system %q is not in the deployment's channel and centres", k))
				}
				keys = append(keys, k)
			}
		}
		if len(keys) == 0 {
			scope := ""
			if d.Fleet != nil {
				scope += " in " + *d.Fleet
			}
			if len(d.Groups) > 0 {
				scope += " in " + strings.Join(d.Groups, ", ")
			}
			return httpx.Validation("no system of type " + m.SystemType + scope + " has any device yet")
		}
		if leftOut > 0 {
			note = fmt.Sprintf("%d system(s) left out: their devices are not all in %s", leftOut, *d.Fleet)
		}
	}
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		d, err := s.st.SystemDeployment(ctx, tx, id)
		if err != nil {
			return err
		}
		refuse := func(want string) error {
			return errSys(fmt.Sprintf("%s is %s: %s needs it %s", d.Name, d.Status, cmd, want))
		}
		switch cmd {
		case "start":
			if d.Status != model.SDDraft {
				return refuse("to be a draft")
			}
			m, err := s.st.Manifest(ctx, tx, d.ManifestID)
			if err != nil {
				return err
			}
			for _, c := range m.Components {
				if _, err := s.checkAssignable(ctx, tx, c.DSID); err != nil {
					return httpx.Validation(fmt.Sprintf("%s: %s", c.ComponentType, err.Error()))
				}
			}
			if err := s.st.CreateRuns(ctx, tx, id, keys); err != nil {
				return err
			}
			d.Status, d.StartedBy, d.StartedAt, d.Reason = model.SDRunning, &user, &now, note
		case "pause":
			if d.Status != model.SDRunning {
				return refuse("running")
			}
			d.Status = model.SDPaused
		case "resume":
			if d.Status != model.SDPaused {
				return refuse("paused")
			}
			d.Status = model.SDRunning
		case "abort":
			if d.Status != model.SDRunning && d.Status != model.SDPaused {
				return refuse("running or paused")
			}
			if err := s.st.SkipPendingRuns(ctx, tx, id, "aborted before it started"); err != nil {
				return err
			}
			d.Status, d.FinishedAt = model.SDAborted, &now
			d.Reason = "aborted by " + user + ifNote(strings.TrimSpace(reason))
		default:
			return httpx.NotFound("Command", cmd)
		}
		return s.st.SetSystemDeploymentState(ctx, tx, d)
	})
}

func ifNote(n string) string {
	if n == "" {
		return ""
	}
	return ": " + n
}

// RollbackSystem puts one system of a deployment back, by hand.
func (s *Service) RollbackSystem(ctx context.Context, user string, deployment, run int64, reason string) error {
	d, err := s.st.SystemDeployment(ctx, s.st.DB(), deployment)
	if err != nil {
		return err
	}
	r, err := s.st.Run(ctx, s.st.DB(), deployment, run)
	if err != nil {
		return err
	}
	if r.Status != model.RunRunning && r.Status != model.RunSucceeded {
		return errSys(fmt.Sprintf("system %s is %s: only a running or finished system is rolled back", r.SystemKey, r.Status))
	}
	if err := s.startRunRollback(ctx, d, r, "rolled back by "+user+ifNote(strings.TrimSpace(reason))); err != nil {
		return err
	}
	if d.Status == model.SDFinished {
		// say it at once: "…, 1 going back", not the count from before
		runs, err := s.st.Runs(ctx, s.st.DB(), deployment)
		if err != nil {
			return err
		}
		d.Reason = summary(runs)
		return s.st.SetSystemDeploymentState(ctx, s.st.DB(), d)
	}
	return nil
}

// ------------------------------------------------------------ the engine

func (s *Service) tickSystems(ctx context.Context) error {
	if err := s.refreshMembers(ctx, false); err != nil {
		return err
	}
	ds, err := s.st.SystemDeployments(ctx, []string{model.SDRunning})
	if err != nil {
		return err
	}
	for _, d := range ds {
		if err := s.stepSystemDeployment(ctx, d); err != nil && ctx.Err() == nil {
			s.log.Warn("system deployment", "name", d.Name, "err", err)
		}
	}
	// A system rolled back by hand after its deployment ended: the deployment
	// is over, its rollback is not. Only running deployments were followed, so
	// such a system stayed "rolling back" for good, and the deployment still
	// said how many systems it had updated before.
	ended, err := s.st.EndedWithRollbacks(ctx)
	if err != nil {
		return err
	}
	for _, d := range ended {
		if err := s.settleRollbacks(ctx, d); err != nil && ctx.Err() == nil {
			s.log.Warn("system deployment", "name", d.Name, "err", err)
		}
	}
	return nil
}

// settleRollbacks follows the rollbacks of a deployment that has ended, and
// says again how it stands.
func (s *Service) settleRollbacks(ctx context.Context, d model.SystemDeployment) error {
	runs, err := s.st.Runs(ctx, s.st.DB(), d.ID)
	if err != nil {
		return err
	}
	for _, r := range runs {
		if r.Status == model.RunRollingBack {
			if err := s.stepRunRollback(ctx, r); err != nil {
				return err
			}
		}
	}
	if d.Status != model.SDFinished {
		return nil
	}
	if runs, err = s.st.Runs(ctx, s.st.DB(), d.ID); err != nil {
		return err
	}
	d.Reason = summary(runs)
	return s.st.SetSystemDeploymentState(ctx, s.st.DB(), d)
}

// summary is how a finished deployment's systems ended.
func summary(runs []model.SystemRun) string {
	var ok, back, going int
	for _, r := range runs {
		switch r.Status {
		case model.RunSucceeded:
			ok++
		case model.RunRolledBack:
			back++
		case model.RunRollingBack:
			going++
		}
	}
	out := fmt.Sprintf("%d of %d systems updated", ok, len(runs))
	if back > 0 {
		out += fmt.Sprintf(", %d rolled back", back)
	}
	if going > 0 {
		out += fmt.Sprintf(", %d going back", going)
	}
	return out
}

// assignIDs gives these targets a set, a hundred per transaction.
func (s *Service) assignIDs(ctx context.Context, user string, ds int64, typ string, ids []int64) (int, error) {
	if len(ids) == 0 {
		return 0, nil
	}
	cids, err := s.st.ControllerIDsOf(ctx, ids)
	if err != nil {
		return 0, err
	}
	reqs := make([]AssignRequest, 0, len(cids))
	for _, c := range cids {
		reqs = append(reqs, AssignRequest{ControllerID: c, Type: typ})
	}
	assigned := 0
	for len(reqs) > 0 {
		n := min(assignSlice, len(reqs))
		res, err := s.Assign(ctx, user, ds, reqs[:n])
		if err != nil {
			return assigned, err
		}
		assigned += res.Assigned
		reqs = reqs[n:]
	}
	return assigned, nil
}

func (s *Service) stepSystemDeployment(ctx context.Context, d model.SystemDeployment) error {
	m, err := s.st.Manifest(ctx, s.st.DB(), d.ManifestID)
	if err != nil {
		return err
	}
	t, err := s.st.SystemType(ctx, s.st.DB(), m.SystemTypeID)
	if err != nil {
		return err
	}
	runs, err := s.st.Runs(ctx, s.st.DB(), d.ID)
	if err != nil {
		return err
	}
	for _, r := range runs {
		switch r.Status {
		case model.RunRunning:
			err = s.stepRun(ctx, d, r)
		case model.RunRollingBack:
			err = s.stepRunRollback(ctx, r)
		}
		if err != nil {
			return err
		}
	}
	if runs, err = s.st.Runs(ctx, s.st.DB(), d.ID); err != nil {
		return err
	}
	var active, failed int
	var pending []model.SystemRun
	for _, r := range runs {
		switch r.Status {
		case model.RunRunning, model.RunRollingBack:
			active++
		case model.RunRolledBack:
			failed++
		case model.RunPending:
			pending = append(pending, r)
		}
	}
	now := httpx.Now()
	if failed > d.MaxFailed {
		if len(pending) > 0 {
			if err := s.st.SkipPendingRuns(ctx, s.st.DB(), d.ID,
				fmt.Sprintf("not started: %d systems had failed, more than the %d allowed", failed, d.MaxFailed)); err != nil {
				return err
			}
		}
		if active == 0 {
			d.Status, d.FinishedAt = model.SDFailed, &now
			d.Reason = fmt.Sprintf("%d systems failed and were rolled back, more than the %d allowed", failed, d.MaxFailed)
			s.log.Warn("system deployment failed", "name", d.Name, "failed", failed)
			return s.st.SetSystemDeploymentState(ctx, s.st.DB(), d)
		}
		return nil
	}
	for _, r := range pending {
		if active >= d.MaxParallel {
			break
		}
		if err := s.startRun(ctx, m, t, r); err != nil {
			return err
		}
		active++
	}
	if active == 0 && len(pending) == 0 {
		d.Status, d.FinishedAt = model.SDFinished, &now
		d.Reason = summary(runs)
		s.log.Info("system deployment finished", "name", d.Name, "reason", d.Reason)
		return s.st.SetSystemDeploymentState(ctx, s.st.DB(), d)
	}
	return nil
}

// startRun records the devices of one system and begins its first order.
func (s *Service) startRun(ctx context.Context, m model.Manifest, t model.SystemType, r model.SystemRun) error {
	match := map[string]string{}
	for _, c := range t.Components {
		match[c.ComponentType] = c.Match
	}
	for _, c := range m.Components {
		ds, err := s.st.DistributionSet(ctx, s.st.DB(), c.DSID)
		if err != nil {
			return err
		}
		ids, err := s.st.Matching(ctx, s.st.DB(), match[c.ComponentType], compatible(ds.TypeID))
		if err != nil {
			return err
		}
		kv, err := s.st.KeyValues(ctx, ids, t.KeyField)
		if err != nil {
			return err
		}
		var mine []int64
		for _, id := range ids {
			if kv[id] == r.SystemKey {
				mine = append(mine, id)
			}
		}
		if len(mine) > 0 {
			if err := s.st.SnapshotRun(ctx, r.ID, mine, c.ComponentType, c.Order, c.DSID); err != nil {
				return err
			}
		}
	}
	now := httpx.Now()
	first, ok, err := s.st.NextOrder(ctx, r.ID, -1)
	if err != nil {
		return err
	}
	r.StartedAt = &now
	if !ok {
		r.Status, r.FinishedAt, r.Reason = model.RunSucceeded, &now, "no device of this system matched the manifest"
		return s.st.SetRunState(ctx, s.st.DB(), r)
	}
	r.Status, r.CurrentOrder, r.StageAt = model.RunRunning, &first, &now
	s.log.Info("system started", "system", r.SystemKey, "order", first)
	return s.st.SetRunState(ctx, s.st.DB(), r)
}

func (s *Service) stepRun(ctx context.Context, d model.SystemDeployment, r model.SystemRun) error {
	if r.CurrentOrder == nil || r.StageAt == nil {
		return nil
	}
	order := *r.CurrentOrder
	p, err := s.st.StageProgress(ctx, r.ID, order, *r.StageAt)
	if err != nil {
		return err
	}
	if p.Failed > 0 {
		return s.startRunRollback(ctx, d, r, fmt.Sprintf("%d device(s) failed at order %d", p.Failed, order))
	}
	if p.Unassigned > 0 {
		groups, err := s.st.StageUnassigned(ctx, r.ID, order)
		if err != nil {
			return err
		}
		for ds, ids := range groups {
			if _, err := s.assignIDs(ctx, sysUser+d.Name, ds, d.ActionType, ids); err != nil {
				return err
			}
			if err := s.st.MarkRunAssigned(ctx, r.ID, ids); err != nil {
				return err
			}
		}
		return nil
	}
	if p.Active > 0 {
		return nil
	}
	if p.Succeeded < p.Targets {
		return s.startRunRollback(ctx, d, r, fmt.Sprintf("%d device(s) at order %d did not finish (cancelled)",
			p.Targets-p.Succeeded, order))
	}
	now := httpx.Now()
	next, ok, err := s.st.NextOrder(ctx, r.ID, order)
	if err != nil {
		return err
	}
	if !ok {
		r.Status, r.FinishedAt, r.Reason = model.RunSucceeded, &now, "every component on its set"
		s.log.Info("system updated", "system", r.SystemKey)
		return s.st.SetRunState(ctx, s.st.DB(), r)
	}
	r.CurrentOrder, r.StageAt = &next, &now
	return s.st.SetRunState(ctx, s.st.DB(), r)
}

// startRunRollback puts every device of the system the deployment updated
// back on the set it ran before.
func (s *Service) startRunRollback(ctx context.Context, d model.SystemDeployment, r model.SystemRun, why string) error {
	groups, err := s.st.RunRollbackCandidates(ctx, r.ID)
	if err != nil {
		return err
	}
	sent := 0
	for prev, ids := range groups {
		n, err := s.assignIDs(ctx, sysUser+d.Name+" (rollback)", prev, model.TypeForced, ids)
		if err != nil {
			return err
		}
		if err := s.st.MarkRunRollbackSent(ctx, r.ID, ids); err != nil {
			return err
		}
		sent += n
	}
	now := httpx.Now()
	r.Status, r.RollbackAt, r.Reason = model.RunRollingBack, &now, why
	s.log.Warn("system rolling back", "system", r.SystemKey, "why", why, "devices", sent)
	return s.st.SetRunState(ctx, s.st.DB(), r)
}

func (s *Service) stepRunRollback(ctx context.Context, r model.SystemRun) error {
	if r.RollbackAt == nil {
		return nil
	}
	rb, err := s.st.RunRollbackProgress(ctx, r.ID, *r.RollbackAt)
	if err != nil {
		return err
	}
	if rb.Active > 0 {
		return nil
	}
	now := httpx.Now()
	r.Status, r.FinishedAt = model.RunRolledBack, &now
	r.Reason += fmt.Sprintf(" -- rolled back: %d of %d devices on their previous set again", rb.Done, rb.Sent)
	if rb.Failed > 0 {
		r.Reason += fmt.Sprintf(", %d failed to go back", rb.Failed)
	}
	if rb.None > 0 {
		r.Reason += fmt.Sprintf(", %d ran nothing before and were left as they are", rb.None)
	}
	return s.st.SetRunState(ctx, s.st.DB(), r)
}
