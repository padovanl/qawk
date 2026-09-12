package service

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/store"
)

// Fleets and the release pipeline (a Qawk addition).
//
// A fleet is a set of devices that should run the same release: dev, beta,
// prod, a trade show. Fleets chain: beta names dev as its upstream, prod
// names beta, and a release reaches a fleet with an upstream only by
// promotion from it, through the fleet's gate -- so many devices of the
// upstream run it, such a share of them, for so long -- and, when the fleet
// asks for it, with a second person's approval. A fleet with no upstream
// (dev, expo) is given releases directly.
//
// In the background, every ten seconds, on the instance running the jobs:
//
//   - a fleet with a rule adopts the devices that match it and are in no
//     fleet yet, so a device registering for the first time lands in the
//     right one from what it reports about itself;
//   - a fleet's current release goes to the members that do not have it and
//     have not been sent it since it started (or since they joined), all at
//     once or in waves; it halts by itself when the share of devices that
//     failed passes the fleet's error threshold;
//   - a frozen fleet is left alone.

func errGate(msg string) error {
	return httpx.Custom(http.StatusConflict, "qawk.fleet.gateClosed", "qawk.GateClosedException", msg)
}

func errFrozen(f model.Fleet) error {
	return httpx.Custom(http.StatusConflict, "qawk.fleet.frozen", "qawk.FleetFrozenException",
		fmt.Sprintf("fleet %s is frozen: %s", f.Name, *f.FreezeReason))
}

func errFourEyes() error {
	return httpx.Custom(http.StatusForbidden, "qawk.release.fourEyes", "qawk.FourEyesException",
		"a release is approved by someone other than who asked for it")
}

func errNoForce() error {
	return httpx.Custom(http.StatusForbidden, "hawkbit.server.error.insufficientpermission",
		"org.eclipse.hawkbit.im.authentication.InsufficientPermissionException",
		"Insufficient Permission: forcing a closed gate needs APPROVE_ROLLOUT")
}

// FleetState is a fleet with its current release, how it is going, and the
// release waiting for approval, if any.
type FleetState struct {
	model.Fleet
	Release  *model.FleetRelease
	Progress *model.ReleaseProgress
	Pending  *model.FleetRelease
	Systems  *Orchestrated // the orchestrator of the current release, when it has one
}

// Orchestrated is how the orchestrator of a release is taking the fleet's
// systems: its deployment, its systems by state, the centre it is on.
type Orchestrated struct {
	Deployment model.SystemDeployment
	Total      int
	Counts     map[string]int
	Centre     string
}

func (s *Service) FleetState(ctx context.Context, f model.Fleet) (FleetState, error) {
	st := FleetState{Fleet: f}
	rel, err := s.st.CurrentRelease(ctx, s.st.DB(), f.ID)
	if err != nil {
		return st, err
	}
	st.Release = rel
	if rel != nil && rel.DSID != nil {
		p, err := s.st.Progress(ctx, f.ID, *rel.DSID, since(rel))
		if err != nil {
			return st, err
		}
		st.Progress = &p
	}
	if rel != nil && rel.SystemDeploymentID != nil {
		if d, err := s.st.SystemDeployment(ctx, s.st.DB(), *rel.SystemDeploymentID); err == nil {
			runs, err := s.st.Runs(ctx, s.st.DB(), d.ID)
			if err != nil {
				return st, err
			}
			o := &Orchestrated{Deployment: d, Total: len(runs), Counts: map[string]int{}}
			for _, r := range runs {
				o.Counts[r.Status]++
				if o.Centre == "" && d.ByGroup &&
					(r.Status == model.RunPending || r.Status == model.RunRunning || r.Status == model.RunRollingBack) {
					o.Centre = r.Group
				}
			}
			st.Systems = o
		}
	}
	st.Pending, err = s.st.PendingRelease(ctx, s.st.DB(), f.ID)
	return st, err
}

func since(r *model.FleetRelease) int64 {
	if r.StartedAt != nil {
		return *r.StartedAt
	}
	return 0
}

// SaveFleet validates a fleet and stores it. release, when not nil, is the
// set the fleet is given directly (0: none) -- refused for a fleet with an
// upstream, which takes releases by promotion. manifest, when not nil, is the
// manifest that goes with it, for the fleet's systems (0: none; nil with a
// set: the one it has).
func (s *Service) SaveFleet(ctx context.Context, user string, f model.Fleet, release, manifest *int64) (int64, error) {
	if strings.TrimSpace(f.Name) == "" {
		return 0, httpx.Validation("a fleet needs a name")
	}
	if f.Rule != nil && strings.TrimSpace(*f.Rule) == "" {
		f.Rule = nil
	}
	if f.Rule != nil {
		if err := s.st.CheckQuery(*f.Rule); err != nil {
			return 0, err
		}
	}
	if f.ActionType == "" {
		f.ActionType = model.TypeForced
	}
	if f.WaveTimeoutMinutes == 0 {
		f.WaveTimeoutMinutes = 60
	}
	if f.Orchestrator.MaxParallel == 0 {
		f.Orchestrator.MaxParallel = 4
	}
	if f.Orchestrator.MaxParallel < 0 || f.Orchestrator.MaxFailed < 0 {
		return 0, httpx.Validation("the orchestrator's systems at a time, and systems that may fail, cannot be negative")
	}
	for _, c := range []struct {
		v    int
		name string
		max  int
	}{
		{f.Gate.MinSuccess, "gate.minSuccess", 100}, {f.WavePercent, "wavePercent", 100},
		{f.ErrorThreshold, "errorThreshold", 100}, {f.Gate.MinDevices, "gate.minDevices", 1 << 30},
		{f.Gate.SoakMinutes, "gate.soakMinutes", 1 << 30}, {f.WaveTimeoutMinutes, "waveTimeoutMinutes", 1 << 30},
	} {
		if c.v < 0 || c.v > c.max {
			return 0, httpx.Validation(fmt.Sprintf("%s must be between 0 and %d", c.name, c.max))
		}
	}
	id := f.ID
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		var err error
		// before the write: a missing upstream is the caller's mistake (400),
		// not a foreign key the database refuses (409)
		if f.UpstreamID != nil {
			if err := s.checkUpstream(ctx, tx, f.ID, *f.UpstreamID); err != nil {
				return err
			}
		}
		if f.ID == 0 {
			if id, err = s.st.CreateFleet(ctx, tx, user, now, f); err != nil {
				return err
			}
		} else {
			if _, err := s.st.Fleet(ctx, tx, f.ID); err != nil {
				return err
			}
			if err := s.st.UpdateFleet(ctx, tx, user, now, f); err != nil {
				return err
			}
		}
		if release == nil && manifest == nil {
			return nil
		}
		cur, err := s.st.Fleet(ctx, tx, id)
		if err != nil {
			return err
		}
		ds := int64(0)
		if release != nil {
			ds = *release
		} else if cur.DSID != nil {
			ds = *cur.DSID
		}
		return s.releaseDirect(ctx, tx, user, cur, ds, manifest, now)
	})
	return id, err
}

// checkUpstream refuses an upstream that does not exist or makes a loop.
func (s *Service) checkUpstream(ctx context.Context, tx pgx.Tx, id, up int64) error {
	for i := 0; i < 64; i++ {
		if up == id {
			return httpx.Validation("a pipeline cannot loop back to the fleet it starts from")
		}
		u, err := s.st.Fleet(ctx, tx, up)
		if err != nil {
			return httpx.Validation(fmt.Sprintf("there is no fleet %d to take releases from", up))
		}
		if u.UpstreamID == nil {
			return nil
		}
		up = *u.UpstreamID
	}
	return httpx.Validation("the pipeline is too long")
}

// sameID: a nullable id and an id (0: none) name the same thing.
func sameID(p *int64, v int64) bool {
	if p == nil {
		return v == 0
	}
	return *p == v
}

func deref64(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}

// releaseDirect gives a fleet with no upstream a release (0: none), with the
// manifest for its systems (nil: the one it has; 0: none).
func (s *Service) releaseDirect(ctx context.Context, tx pgx.Tx, user string, f model.Fleet, dsID int64, manifest *int64, now int64) error {
	mid := f.ManifestID
	if manifest != nil {
		mid = nil
		if *manifest != 0 {
			mid = manifest
		}
	}
	if dsID == 0 {
		if f.DSID == nil {
			return nil
		}
		if err := s.st.SetFleetDS(ctx, tx, user, now, f.ID, nil); err != nil {
			return err
		}
		if err := s.st.SetFleetManifest(ctx, tx, f.ID, nil); err != nil {
			return err
		}
		if err := s.st.EndReleaseDeployments(ctx, tx, f.ID, 0, f.Name+" was given no release", now); err != nil {
			return err
		}
		return s.st.EndReleases(ctx, tx, f.ID, now)
	}
	if f.DSID != nil && *f.DSID == dsID && sameID(f.ManifestID, deref64(mid)) {
		return nil
	}
	if f.UpstreamID != nil {
		return httpx.Validation(fmt.Sprintf("%s takes its releases from %s: promote one from there",
			f.Name, deref(f.UpstreamName)))
	}
	if f.Frozen(now) {
		return errFrozen(f)
	}
	ds, err := s.checkAssignable(ctx, tx, dsID)
	if err != nil {
		return err
	}
	r := model.FleetRelease{FleetID: f.ID, DSID: &dsID, DSLabel: ds.Label(), Status: model.ReleaseActive,
		RequestedBy: user, RequestedAt: now, ManifestID: mid}
	if mid != nil {
		m, err := s.st.Manifest(ctx, tx, *mid)
		if err != nil {
			return httpx.Validation(fmt.Sprintf("there is no manifest %d", *mid))
		}
		r.ManifestLabel = m.Name
	}
	if f.Gate.ApprovalRequired {
		r.Status = model.ReleasePending
	}
	id, err := s.st.CreateRelease(ctx, tx, r)
	if err != nil || r.Status == model.ReleasePending {
		return err
	}
	r.ID = id
	return s.startRelease(ctx, tx, user, f, r, now)
}

// startRelease makes r the fleet's release: its set for the devices that
// stand alone, and -- when it carries a manifest -- the orchestrator for the
// fleet's systems. What the orchestrator was doing for the release it
// supersedes stops.
func (s *Service) startRelease(ctx context.Context, tx pgx.Tx, user string, f model.Fleet, r model.FleetRelease, now int64) error {
	if err := s.st.SetFleetDS(ctx, tx, user, now, f.ID, r.DSID); err != nil {
		return err
	}
	if err := s.st.SetFleetManifest(ctx, tx, f.ID, r.ManifestID); err != nil {
		return err
	}
	if err := s.st.StartRelease(ctx, tx, f.ID, r.ID, now); err != nil {
		return err
	}
	if err := s.st.EndReleaseDeployments(ctx, tx, f.ID, r.ID, fmt.Sprintf("superseded by release %d", r.ID), now); err != nil {
		return err
	}
	return s.orchestrate(ctx, tx, user, f, r, now)
}

// orchestrate starts, for a release that carries a manifest, the system
// deployment that takes the fleet's systems with it: every system whose
// devices are all in the fleet, a few at a time, centre by centre if the
// fleet says so -- in each system the manifest's order, and a system that
// fails goes back on its own. With no system in the fleet it has nothing to
// do and says so.
func (s *Service) orchestrate(ctx context.Context, tx pgx.Tx, user string, f model.Fleet, r model.FleetRelease, now int64) error {
	if r.ManifestID == nil {
		return nil
	}
	m, err := s.st.Manifest(ctx, tx, *r.ManifestID)
	if err != nil {
		return httpx.Validation(fmt.Sprintf("there is no manifest %d", *r.ManifestID))
	}
	for _, c := range m.Components {
		if _, err := s.checkAssignable(ctx, tx, c.DSID); err != nil {
			return httpx.Validation(fmt.Sprintf("%s: %s", c.ComponentType, err.Error()))
		}
	}
	fid := f.ID
	d := model.SystemDeployment{Name: fmt.Sprintf("%s · %s · release %d", f.Name, m.Name, r.ID), ManifestID: m.ID,
		FleetID: &fid, MaxParallel: max(1, f.Orchestrator.MaxParallel), MaxFailed: f.Orchestrator.MaxFailed,
		ActionType: f.ActionType, ByGroup: f.Orchestrator.ByCentre}
	id, err := s.st.CreateSystemDeployment(ctx, tx, user, now, d)
	if err != nil {
		return err
	}
	if d, err = s.st.SystemDeployment(ctx, tx, id); err != nil {
		return err
	}
	keys, groups, note, err := s.scope(ctx, d)
	if err != nil {
		// what it says, not the error code in front of it
		why := err.Error()
		if i := strings.Index(why, ": "); i > 0 && strings.HasPrefix(why, "hawkbit.") {
			why = why[i+2:]
		}
		d.Status, d.FinishedAt, d.Reason = model.SDFinished, &now, why
	} else {
		if err := s.st.CreateRuns(ctx, tx, id, keys, groups); err != nil {
			return err
		}
		d.Status, d.StartedBy, d.StartedAt, d.Reason = model.SDRunning, &user, &now, note
	}
	if err := s.st.SetSystemDeploymentState(ctx, tx, d); err != nil {
		return err
	}
	return s.st.SetReleaseSystemDeployment(ctx, tx, r.ID, id)
}

// systemsDone: the release's orchestrator, if it has one, has finished.
func (s *Service) systemsDone(ctx context.Context, rel *model.FleetRelease) bool {
	if rel.SystemDeploymentID == nil {
		return rel.ManifestID == nil
	}
	d, err := s.st.SystemDeployment(ctx, s.st.DB(), *rel.SystemDeploymentID)
	return err == nil && d.Status == model.SDFinished
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// Gate says whether the release from runs may enter to, and why, line by line.
func (s *Service) Gate(ctx context.Context, to, from int64) (report string, open bool, err error) {
	dst, err := s.st.Fleet(ctx, s.st.DB(), to)
	if err != nil {
		return "", false, err
	}
	src, err := s.st.Fleet(ctx, s.st.DB(), from)
	if err != nil {
		return "", false, err
	}
	rel, err := s.st.CurrentRelease(ctx, s.st.DB(), from)
	if err != nil {
		return "", false, err
	}
	report, open, err = s.gate(ctx, dst, src, rel, httpx.Now())
	return report, open, err
}

func (s *Service) gate(ctx context.Context, dst, src model.Fleet, rel *model.FleetRelease, now int64) (string, bool, error) {
	if rel == nil || rel.DSID == nil {
		return "✗ " + src.Name + " runs no release", false, nil
	}
	if dst.UpstreamID == nil {
		return "✓ " + dst.Name + " stands alone: no gate", true, nil
	}
	p, err := s.st.Progress(ctx, src.ID, *rel.DSID, since(rel))
	if err != nil {
		return "", false, err
	}
	g := dst.Gate
	var lines []string
	open := true
	check := func(ok bool, line string) {
		mark := "✓ "
		if !ok {
			mark, open = "✗ ", false
		}
		lines = append(lines, mark+line)
	}
	pct := int64(0)
	if p.Members > 0 {
		pct = p.OnRelease * 100 / p.Members
	}
	soak := (now - since(rel)) / 60_000
	check(rel.Status != model.ReleaseHalted, fmt.Sprintf("%s in %s is not halted", rel.DSLabel, src.Name))
	check(p.OnRelease >= int64(g.MinDevices),
		fmt.Sprintf("%d devices of %s run %s (at least %d)", p.OnRelease, src.Name, rel.DSLabel, g.MinDevices))
	check(p.Members > 0 && pct >= int64(g.MinSuccess),
		fmt.Sprintf("%d%% of %s runs it (at least %d%%)", pct, src.Name, g.MinSuccess))
	check(soak >= int64(g.SoakMinutes),
		fmt.Sprintf("it has been in %s for %d minutes (at least %d)", src.Name, soak, g.SoakMinutes))
	// the systems too: the release is through the upstream once its
	// orchestrator has taken the upstream's systems
	if rel.ManifestID != nil {
		line := fmt.Sprintf("the orchestrator has not started on %s's systems", src.Name)
		done := false
		if rel.SystemDeploymentID != nil {
			if d, err := s.st.SystemDeployment(ctx, s.st.DB(), *rel.SystemDeploymentID); err == nil {
				done = d.Status == model.SDFinished
				line = fmt.Sprintf("the orchestrator took %s's systems with %s: %s", src.Name, rel.ManifestLabel, d.Status)
				if d.Reason != "" {
					line += " (" + d.Reason + ")"
				}
			}
		}
		check(done, line)
	}
	return strings.Join(lines, "\n"), open, nil
}

// Promote asks for to to get the release from runs: "prod gets what beta
// has". Through the gate, or past it with force, a reason and APPROVE_ROLLOUT;
// then at once, or once someone else approves.
//
// orchestrator: whether the release's manifest comes along, for the fleet's
// systems (nil: yes, when it has one -- as a promotion by itself does).
func (s *Service) Promote(ctx context.Context, user string, canForce bool, to, from int64, force bool, reason string,
	orchestrator *bool) (model.FleetRelease, error) {
	var out model.FleetRelease
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		dst, err := s.st.Fleet(ctx, tx, to)
		if err != nil {
			return err
		}
		src, err := s.st.Fleet(ctx, tx, from)
		if err != nil {
			return err
		}
		if to == from {
			return httpx.Validation("a fleet cannot be promoted from itself")
		}
		if dst.UpstreamID != nil && *dst.UpstreamID != from {
			return httpx.Validation(fmt.Sprintf("%s takes its releases from %s, not from %s",
				dst.Name, deref(dst.UpstreamName), src.Name))
		}
		if dst.Frozen(now) {
			return errFrozen(dst)
		}
		rel, err := s.st.CurrentRelease(ctx, tx, from)
		if err != nil {
			return err
		}
		report, open, err := s.gate(ctx, dst, src, rel, now)
		if err != nil {
			return err
		}
		if rel == nil || rel.DSID == nil {
			return httpx.Validation(src.Name + " runs no release: there is nothing to promote")
		}
		if !open {
			if !force {
				return errGate(fmt.Sprintf("the gate into %s is closed:\n%s", dst.Name, report))
			}
			if !canForce {
				return errNoForce()
			}
			if strings.TrimSpace(reason) == "" {
				return httpx.Validation("say why the gate is forced: it goes in the release's history")
			}
		}
		ds, err := s.checkAssignable(ctx, tx, *rel.DSID)
		if err != nil {
			return err
		}
		r := model.FleetRelease{FleetID: to, DSID: rel.DSID, DSLabel: ds.Label(), FromFleetID: &from,
			FromFleetName: src.Name, Status: model.ReleaseActive, Forced: !open, Reason: strings.TrimSpace(reason),
			GateReport: report, RequestedBy: user, RequestedAt: now}
		if orchestrator == nil || *orchestrator {
			r.ManifestID, r.ManifestLabel = rel.ManifestID, rel.ManifestLabel
		}
		if dst.Gate.ApprovalRequired {
			r.Status = model.ReleasePending
		}
		id, err := s.st.CreateRelease(ctx, tx, r)
		if err != nil {
			return err
		}
		r.ID = id
		if r.Status == model.ReleaseActive {
			if err := s.startRelease(ctx, tx, user, dst, r, now); err != nil {
				return err
			}
		}
		out, err = s.st.Release(ctx, tx, id)
		return err
	})
	return out, err
}

// Approve lets a release waiting for approval go out. Four eyes: not by the
// person who asked for it.
func (s *Service) Approve(ctx context.Context, user string, id int64, note string) (model.FleetRelease, error) {
	var out model.FleetRelease
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		r, err := s.st.Release(ctx, tx, id)
		if err != nil {
			return err
		}
		if r.Status != model.ReleasePending {
			return httpx.Validation(fmt.Sprintf("release %d is %s, not waiting for approval", id, r.Status))
		}
		if strings.EqualFold(r.RequestedBy, user) {
			return errFourEyes()
		}
		f, err := s.st.Fleet(ctx, tx, r.FleetID)
		if err != nil {
			return err
		}
		if f.Frozen(now) {
			return errFrozen(f)
		}
		if r.DSID == nil {
			return httpx.Validation("the set of this release has been deleted")
		}
		if _, err := s.checkAssignable(ctx, tx, *r.DSID); err != nil {
			return err
		}
		if err := s.st.DecideRelease(ctx, tx, id, model.ReleaseActive, user, note, now); err != nil {
			return err
		}
		if err := s.startRelease(ctx, tx, user, f, r, now); err != nil {
			return err
		}
		out, err = s.st.Release(ctx, tx, id)
		return err
	})
	return out, err
}

func (s *Service) Deny(ctx context.Context, user string, id int64, note string) (model.FleetRelease, error) {
	var out model.FleetRelease
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		r, err := s.st.Release(ctx, tx, id)
		if err != nil {
			return err
		}
		if r.Status != model.ReleasePending {
			return httpx.Validation(fmt.Sprintf("release %d is %s, not waiting for approval", id, r.Status))
		}
		if err := s.st.DecideRelease(ctx, tx, id, model.ReleaseDenied, user, note, now); err != nil {
			return err
		}
		out, err = s.st.Release(ctx, tx, id)
		return err
	})
	return out, err
}

// Resume lets a halted release go on. The failures that halted it are
// counted as already seen: only new ones can halt it again.
func (s *Service) Resume(ctx context.Context, user string, fleet int64) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		r, err := s.st.CurrentRelease(ctx, tx, fleet)
		if err != nil {
			return err
		}
		if r == nil || r.Status != model.ReleaseHalted || r.DSID == nil {
			return httpx.Validation("this fleet has no halted release")
		}
		p, err := s.st.Progress(ctx, fleet, *r.DSID, since(r))
		if err != nil {
			return err
		}
		return s.st.ResumeRelease(ctx, tx, r.ID, p.Failed)
	})
}

// Freeze stops every release reaching a fleet, from from to until (either
// may be nil: now, for ever). A person can still assign a device through the
// hawkBit API; the audit log says who did.
func (s *Service) Freeze(ctx context.Context, user string, fleet int64, reason string, from, until *int64) error {
	if strings.TrimSpace(reason) == "" {
		return httpx.Validation("a freeze needs a reason: the console shows it to whoever tries to release")
	}
	if from != nil && until != nil && *until <= *from {
		return httpx.Validation("a freeze must end after it starts")
	}
	reason = strings.TrimSpace(reason)
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if _, err := s.st.Fleet(ctx, tx, fleet); err != nil {
			return err
		}
		return s.st.SetFreeze(ctx, tx, user, now, fleet, &reason, from, until)
	})
}

func (s *Service) Thaw(ctx context.Context, user string, fleet int64) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if _, err := s.st.Fleet(ctx, tx, fleet); err != nil {
			return err
		}
		return s.st.SetFreeze(ctx, tx, user, now, fleet, nil, nil, nil)
	})
}

// SetMembers puts devices into a fleet by hand (fleet nil: out of theirs).
// Into a temporary fleet they remember the one they came from.
func (s *Service) SetMembers(ctx context.Context, user string, controllerIDs []string, fleet *int64) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		temporary := false
		if fleet != nil {
			f, err := s.st.Fleet(ctx, tx, *fleet)
			if err != nil {
				return err
			}
			temporary = f.Temporary
		}
		ids, err := s.st.IDsOf(ctx, tx, controllerIDs)
		if err != nil {
			return err
		}
		if err := s.checkCentreMove(ctx, tx, ids, fleet, temporary); err != nil {
			return err
		}
		return s.st.SetFleet(ctx, tx, ids, fleet, now, temporary)
	})
}

// ReturnHome sends a temporary fleet's devices back to the fleets they came
// from (all, or those listed); there they get that fleet's release again.
func (s *Service) ReturnHome(ctx context.Context, user string, fleet int64, controllerIDs []string) (returned, homeless int64, err error) {
	err = s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if _, err := s.st.Fleet(ctx, tx, fleet); err != nil {
			return err
		}
		var ids []int64
		if len(controllerIDs) > 0 {
			var err error
			if ids, err = s.st.IDsOf(ctx, tx, controllerIDs); err != nil {
				return err
			}
		}
		var err error
		returned, homeless, err = s.st.ReturnHome(ctx, tx, fleet, ids, now)
		return err
	})
	return returned, homeless, err
}

// ------------------------------------------------------------ background

func (s *Service) tickFleets(ctx context.Context) error {
	fleets, err := s.st.Fleets(ctx)
	if err != nil {
		return err
	}
	now := httpx.Now()
	for _, f := range fleets {
		s.adopt(ctx, f)
		s.autoPromote(ctx, f, now)
		if f.DSID == nil || f.Frozen(now) {
			continue
		}
		if err := s.deliver(ctx, f, now); err != nil && ctx.Err() == nil {
			s.log.Warn("fleet release", "fleet", f.Name, "err", err)
		}
	}
	return nil
}

// adopt puts the devices matching a fleet's rule, and in no fleet, into it.
func (s *Service) adopt(ctx context.Context, f model.Fleet) {
	if f.Rule == nil || *f.Rule == "" {
		return
	}
	ids, err := s.st.Matching(ctx, s.st.DB(), *f.Rule, func(a *store.Args) []string {
		return []string{"t.fleet_id IS NULL"}
	})
	if err != nil {
		s.log.Warn("fleet rule", "fleet", f.Name, "err", err)
		return
	}
	if len(ids) == 0 {
		return
	}
	fid := f.ID
	if err := s.st.Tx(ctx, "system", func(tx pgx.Tx, now int64) error {
		return s.st.SetFleet(ctx, tx, ids, &fid, now, false)
	}); err != nil {
		s.log.Warn("fleet adoption", "fleet", f.Name, "err", err)
		return
	}
	s.log.Info("devices joined a fleet by its rule", "fleet", f.Name, "devices", len(ids))
}

// autoPromote promotes a fleet that is set to promote itself, as soon as its
// gate opens -- once per release of its upstream: a promotion it already
// asked for, approved or denied, is not asked for again. It goes through
// Promote, as a person's would: the same gate, the approval when the fleet
// asks for one (anyone may approve what "system" asked for), the history,
// the audit log. By default fleets are promoted by hand: someone looks at the
// gate, decides, and presses promote.
func (s *Service) autoPromote(ctx context.Context, f model.Fleet, now int64) {
	if !f.AutoPromote || f.UpstreamID == nil || f.Frozen(now) {
		return
	}
	rel, err := s.st.CurrentRelease(ctx, s.st.DB(), *f.UpstreamID)
	if err != nil || rel == nil || rel.DSID == nil || rel.Status == model.ReleaseHalted {
		return
	}
	if f.DSID != nil && *f.DSID == *rel.DSID {
		return
	}
	asked, err := s.st.Releases(ctx, f.ID, "", 20)
	if err != nil {
		return
	}
	for _, r := range asked {
		if r.DSID != nil && *r.DSID == *rel.DSID && r.RequestedAt >= since(rel) {
			return
		}
	}
	src, err := s.st.Fleet(ctx, s.st.DB(), *f.UpstreamID)
	if err != nil {
		return
	}
	if _, open, err := s.gate(ctx, f, src, rel, now); err != nil || !open {
		return
	}
	r, err := s.Promote(ctx, "system", false, f.ID, *f.UpstreamID, false, "promoted by itself: the gate opened", nil)
	if err != nil {
		s.log.Warn("automatic promotion", "fleet", f.Name, "err", err)
		return
	}
	s.log.Info("fleet promoted itself", "fleet", f.Name, "set", r.DSLabel, "status", r.Status)
}

// deliver sends a fleet's current release on: the next wave, or everyone.
func (s *Service) deliver(ctx context.Context, f model.Fleet, now int64) error {
	rel, err := s.st.CurrentRelease(ctx, s.st.DB(), f.ID)
	if err != nil || rel == nil || rel.Status == model.ReleaseHalted || rel.DSID == nil || *rel.DSID != *f.DSID {
		return err
	}
	// the orchestrator failed -- more systems went back than the fleet allows:
	// the release stops, as it does when too many devices fail
	if rel.Status == model.ReleaseActive && rel.SystemDeploymentID != nil {
		if d, err := s.st.SystemDeployment(ctx, s.st.DB(), *rel.SystemDeploymentID); err == nil && d.Status == model.SDFailed {
			s.log.Warn("fleet release halted by its orchestrator", "fleet", f.Name, "reason", d.Reason)
			return s.st.HaltRelease(ctx, rel.ID, "halted: the orchestrator: "+d.Reason, now)
		}
	}
	dsID, from := *f.DSID, since(rel)
	ds, err := s.st.DistributionSet(ctx, s.st.DB(), dsID)
	if err != nil || ds.Deleted || !ds.Valid || !ds.Complete {
		return nil
	}
	p, err := s.st.Progress(ctx, f.ID, dsID, from)
	if err != nil {
		return err
	}
	started := p.Succeeded + p.Failed
	fresh := p.Failed - int64(rel.FailureBaseline)
	if fresh > 0 && started > 0 && fresh*100 > int64(f.ErrorThreshold)*started {
		why := fmt.Sprintf("halted: %d of %d devices failed (%d%%), over the %d%% threshold",
			fresh, started, fresh*100/started, f.ErrorThreshold)
		s.log.Warn("fleet release halted", "fleet", f.Name, "set", ds.Label(), "failed", fresh, "started", started)
		return s.st.HaltRelease(ctx, rel.ID, why, now)
	}
	fid := f.ID
	ids, err := s.st.Matching(ctx, s.st.DB(), "", func(a *store.Args) []string {
		d := a.Bind(dsID)
		return append(compatible(ds.TypeID)(a),
			"t.fleet_id = "+a.Bind(fid),
			// a device of a system: system deployments update it, not the channel
			"NOT EXISTS (SELECT 1 FROM system_members sm WHERE sm.target_id = t.id)",
			"t.assigned_ds_id IS DISTINCT FROM "+d,
			"NOT EXISTS (SELECT 1 FROM actions x WHERE x.target_id = t.id AND x.ds_id = "+d+
				" AND x.created_at >= greatest("+a.Bind(from)+"::bigint, coalesce(t.fleet_joined_at, 0)))")
	})
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		// done: the devices that stand alone on it (a fleet of systems only
		// has none), and the orchestrator finished with the systems
		standalone := p.OnRelease == p.Members && (p.Members > 0 || rel.ManifestID != nil)
		if rel.Status == model.ReleaseActive && p.Active == 0 && standalone && s.systemsDone(ctx, rel) {
			s.log.Info("fleet release completed", "fleet", f.Name, "set", ds.Label(), "devices", p.Members)
			return s.st.CompleteRelease(ctx, rel.ID, now)
		}
		return nil
	}
	if f.WavePercent > 0 {
		// the next wave when this one is done, or has had its time
		if p.Active > 0 && (rel.LastWaveAt == nil || now-*rel.LastWaveAt < int64(f.WaveTimeoutMinutes)*60_000) {
			return nil
		}
		size := int((p.Members*int64(f.WavePercent) + 99) / 100)
		if size < 1 {
			size = 1
		}
		if len(ids) > size {
			ids = ids[:size]
		}
	}
	reqs := make([]AssignRequest, 0, len(ids))
	for _, id := range ids {
		if t, err := s.st.TargetByID(ctx, s.st.DB(), id); err == nil {
			reqs = append(reqs, AssignRequest{ControllerID: t.ControllerID, Type: f.ActionType})
		}
	}
	// In slices of a hundred, each in its own transaction. One transaction for
	// a wave of two thousand held those devices' rows for minutes on a busy
	// disk, and their reports waited behind it until they timed out (measured:
	// 809 devices of prod stuck, their feedback answered 500 after 30 s).
	assigned := 0
	for len(reqs) > 0 {
		n := min(assignSlice, len(reqs))
		res, err := s.Assign(ctx, rel.RequestedBy, dsID, reqs[:n])
		if err != nil {
			return err
		}
		assigned += res.Assigned
		reqs = reqs[n:]
	}
	if assigned > 0 {
		if err := s.st.MarkWave(ctx, rel.ID, now); err != nil {
			return err
		}
		s.log.Info("fleet release sent", "fleet", f.Name, "set", ds.Label(), "devices", assigned, "wave", rel.Waves+1)
	}
	return nil
}

// assignSlice is how many devices one transaction assigns at most.
const assignSlice = 100
