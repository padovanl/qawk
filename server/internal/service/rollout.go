package service

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/store"
)

// Rollouts: one set, to every target a query selects, in groups, one group
// after the other, stopping when too many fail.

type GroupDef struct {
	Name                 string
	Description          string
	TargetFilterQuery    string
	TargetPercentage     float64
	SuccessCondition     *model.Condition
	SuccessAction        *model.Condition
	ErrorCondition       *model.Condition
	ErrorAction          *model.Condition
	ConfirmationRequired *bool
}

type RolloutDef struct {
	Name                 string
	Description          string
	DSID                 int64
	TargetFilterQuery    string
	ActionType           string
	ForceTime            int64
	Weight               *int
	StartAt              *int64
	ConfirmationRequired *bool
	Dynamic              bool
	AmountGroups         int
	Groups               []GroupDef
	// defaults for every group that does not say otherwise
	SuccessCondition *model.Condition
	SuccessAction    *model.Condition
	ErrorCondition   *model.Condition
	ErrorAction      *model.Condition
}

// compatible keeps only the targets whose type accepts the set's type.
func compatible(dsTypeID int64) func(a *store.Args) []string {
	return func(a *store.Args) []string {
		return []string{"(t.target_type_id IS NULL OR EXISTS (SELECT 1 FROM target_type_ds_types c " +
			"WHERE c.target_type_id = t.target_type_id AND c.ds_type_id = " + a.Bind(dsTypeID) + "))"}
	}
}

// CreateRollout creates a rollout and splits its targets into groups.
//
// With amountGroups the targets are shared out evenly, in id order. With
// explicit groups, each group takes its percentage of the targets that match
// its own query (and the rollout's) and are not in an earlier group yet --
// hawkBit's rule, so that a target is never in two groups.
func (s *Service) CreateRollout(ctx context.Context, user string, d RolloutDef) (int64, error) {
	var id int64
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		ds, err := s.checkAssignable(ctx, tx, d.DSID)
		if err != nil {
			return err
		}
		if strings.TrimSpace(d.TargetFilterQuery) == "" {
			return httpx.Validation("targetFilterQuery must not be empty")
		}
		if err := s.st.CheckQuery(d.TargetFilterQuery); err != nil {
			return err
		}
		matching, err := s.st.Matching(ctx, tx, d.TargetFilterQuery, compatible(ds.TypeID))
		if err != nil {
			return err
		}
		if len(matching) == 0 {
			return httpx.Validation("The rollout's query matches no target that can receive this distribution set")
		}
		status := model.RolloutReady
		if s.st.ConfigBool(ctx, "rollout.approval.enabled") {
			status = model.RolloutWaitingForApproval
		}
		typ := d.ActionType
		if typ == "" {
			typ = model.TypeForced
		}
		weight := d.Weight
		if weight == nil {
			w := DefaultWeight
			weight = &w
		}
		id, err = s.st.CreateRollout(ctx, tx, user, now, model.Rollout{
			Name: d.Name, Description: d.Description, DSID: ds.ID, TargetFilterQuery: d.TargetFilterQuery,
			ActionType: typ, ForcedTime: d.ForceTime, Weight: weight, Status: status, Dynamic: d.Dynamic,
			StartAt: d.StartAt, ConfirmationRequired: d.ConfirmationRequired,
		})
		if err != nil {
			return err
		}

		groups := d.Groups
		if len(groups) == 0 {
			n := d.AmountGroups
			if n < 1 {
				n = 1
			}
			if n > len(matching) {
				n = len(matching)
			}
			for i := 0; i < n; i++ {
				groups = append(groups, GroupDef{Name: "group-" + strconv.Itoa(i+1),
					Description: "group-" + strconv.Itoa(i+1), TargetPercentage: 100 / float64(n-i)})
			}
		}
		taken := map[int64]bool{}
		var total int64
		for i, g := range groups {
			pool := matching
			if strings.TrimSpace(g.TargetFilterQuery) != "" {
				if err := s.st.CheckQuery(g.TargetFilterQuery); err != nil {
					return err
				}
				pool, err = s.st.Matching(ctx, tx, "("+d.TargetFilterQuery+");("+g.TargetFilterQuery+")", compatible(ds.TypeID))
				if err != nil {
					return err
				}
			}
			var free []int64
			for _, t := range pool {
				if !taken[t] {
					free = append(free, t)
				}
			}
			pct := g.TargetPercentage
			if pct <= 0 || pct > 100 {
				pct = 100
			}
			n := int(math.Ceil(float64(len(free)) * pct / 100))
			if n > len(free) {
				n = len(free)
			}
			chosen := free[:n]
			for _, t := range chosen {
				taken[t] = true
			}
			grp := model.RolloutGroup{
				RolloutID: id, Position: i, Name: g.Name, Description: g.Description, Status: model.GroupReady,
				TargetFilterQuery: g.TargetFilterQuery, TargetPercentage: pct,
				SuccessCondition: pick(g.SuccessCondition, d.SuccessCondition, model.Condition{Condition: "THRESHOLD", Expression: "100"}),
				SuccessAction:    pick(g.SuccessAction, d.SuccessAction, model.Condition{Condition: "NEXTGROUP"}),
				ErrorCondition:   pickPtr(g.ErrorCondition, d.ErrorCondition),
				ErrorAction:      pickPtr(g.ErrorAction, d.ErrorAction),
				ConfirmationRequired: g.ConfirmationRequired, TotalTargets: int64(len(chosen)),
			}
			if grp.Name == "" {
				grp.Name = "group-" + strconv.Itoa(i+1)
			}
			if grp.ErrorCondition != nil && grp.ErrorAction == nil {
				grp.ErrorAction = &model.Condition{Condition: "PAUSE"}
			}
			gid, err := s.st.CreateGroup(ctx, tx, user, now, grp)
			if err != nil {
				return err
			}
			if err := s.st.AddGroupTargets(ctx, tx, gid, chosen); err != nil {
				return err
			}
			total += int64(len(chosen))
		}
		o, err := s.st.Rollout(ctx, tx, id)
		if err != nil {
			return err
		}
		o.TotalTargets = total
		return s.st.UpdateRollout(ctx, tx, user, now, o)
	})
	return id, err
}

func pick(a, b *model.Condition, def model.Condition) model.Condition {
	if a != nil {
		return *a
	}
	if b != nil {
		return *b
	}
	return def
}

func pickPtr(a, b *model.Condition) *model.Condition {
	if a != nil {
		return a
	}
	return b
}

func errRolloutState(o model.Rollout, want string) error {
	return httpx.Custom(400, "hawkbit.server.error.rollout.illegalstate",
		repoExc+"RolloutIllegalStateException",
		fmt.Sprintf("Rollout %d is %s; this needs it to be %s", o.ID, o.Status, want))
}

// RolloutCommand runs one of the operator's commands on a rollout.
func (s *Service) RolloutCommand(ctx context.Context, user string, id int64, cmd string, remark *string) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		o, err := s.st.RolloutForUpdate(ctx, tx, id)
		if err != nil {
			return err
		}
		switch cmd {
		case "start":
			if o.Status != model.RolloutReady {
				return errRolloutState(o, "ready")
			}
			return s.startRollout(ctx, tx, user, now, o)
		case "pause":
			if o.Status != model.RolloutRunning {
				return errRolloutState(o, "running")
			}
			o.Status = model.RolloutPaused
		case "resume":
			if o.Status != model.RolloutPaused {
				return errRolloutState(o, "paused")
			}
			o.Status = model.RolloutRunning
		case "approve", "deny":
			if o.Status != model.RolloutWaitingForApproval {
				return errRolloutState(o, "waiting_for_approval")
			}
			o.Status = model.RolloutReady
			if cmd == "deny" {
				o.Status = model.RolloutApprovalDenied
			}
			o.ApprovalDecidedBy = &user
			o.ApprovalRemark = remark
		case "triggerNextGroup":
			if o.Status != model.RolloutRunning {
				return errRolloutState(o, "running")
			}
			started, err := s.startNextGroup(ctx, tx, user, now, o)
			if err != nil {
				return err
			}
			if !started {
				return httpx.Custom(400, "hawkbit.server.error.rollout.illegalstate",
					repoExc+"RolloutIllegalStateException", "there is no group left to start")
			}
			return nil
		default:
			return httpx.Validation("unknown rollout command " + cmd)
		}
		return s.st.UpdateRollout(ctx, tx, user, now, o)
	})
}

// DeleteRollout cancels what a rollout still has running and removes it.
func (s *Service) DeleteRollout(ctx context.Context, user string, id int64) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		o, err := s.st.RolloutForUpdate(ctx, tx, id)
		if err != nil {
			return err
		}
		groups, err := s.st.AllGroups(ctx, tx, o.ID)
		if err != nil {
			return err
		}
		for _, g := range groups {
			acts, err := s.st.GroupActions(ctx, tx, g.ID)
			if err != nil {
				return err
			}
			for _, a := range acts {
				if !a.Active || a.Status == model.StatusCanceling {
					continue
				}
				if err := s.st.SetAction(ctx, tx, a.ID, model.StatusCanceling, true, nil, user, now); err != nil {
					return err
				}
				if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: model.StatusCanceling,
					OccurredAt: now, ReportedAt: now, Messages: []string{MsgCancelRequested}}); err != nil {
					return err
				}
			}
		}
		return s.st.DeleteRollout(ctx, tx, user, now, o.ID)
	})
}

func (s *Service) startRollout(ctx context.Context, tx pgx.Tx, user string, now int64, o model.Rollout) error {
	o.Status = model.RolloutRunning
	if err := s.st.UpdateRollout(ctx, tx, user, now, o); err != nil {
		return err
	}
	_, err := s.startNextGroup(ctx, tx, user, now, o)
	return err
}

// startNextGroup starts the first group still waiting; false if none is.
func (s *Service) startNextGroup(ctx context.Context, tx pgx.Tx, user string, now int64, o model.Rollout) (bool, error) {
	groups, err := s.st.AllGroups(ctx, tx, o.ID)
	if err != nil {
		return false, err
	}
	for _, g := range groups {
		if g.Status != model.GroupReady && g.Status != model.GroupScheduled {
			continue
		}
		return true, s.startGroup(ctx, tx, user, now, o, g)
	}
	return false, nil
}

// startGroup creates the group's actions -- assigning, target by target, as an
// operator would -- and marks the group running.
func (s *Service) startGroup(ctx context.Context, tx pgx.Tx, user string, now int64, o model.Rollout, g model.RolloutGroup) error {
	ds, err := s.st.DistributionSet(ctx, tx, o.DSID)
	if err != nil {
		return err
	}
	if s.st.ConfigBool(ctx, "implicit.lock.enabled") {
		if err := s.st.Lock(ctx, tx, ds.ID); err != nil {
			return err
		}
	}
	confirmFlow := s.st.ConfigBool(ctx, "user.confirmation.flow.enabled")
	ids, err := s.st.GroupTargetIDs(ctx, tx, g.ID)
	if err != nil {
		return err
	}
	confirm := g.ConfirmationRequired
	if confirm == nil {
		confirm = o.ConfirmationRequired
	}
	rid, gid := o.ID, g.ID
	for _, tid := range ids {
		t, err := s.st.TargetByID(ctx, tx, tid)
		if err != nil {
			return err
		}
		if _, err := s.createAction(ctx, tx, user, now, t, ds, AssignRequest{
			ControllerID: t.ControllerID, Type: o.ActionType, ForceTime: o.ForcedTime, Weight: o.Weight,
			ConfirmationRequired: confirm, RolloutID: &rid, GroupID: &gid,
		}, confirmFlow); err != nil {
			return err
		}
	}
	return s.st.SetGroupStatus(ctx, tx, g.ID, model.GroupRunning, int64(len(ids)), user, now)
}

// ----------------------------------------------------------------- engine

// tickRollouts moves every rollout on by one step: starts the ones whose time
// has come, closes groups that met their success condition and starts the
// next, pauses the ones whose error condition was met, finishes the ones with
// nothing left to do.
func (s *Service) tickRollouts(ctx context.Context) error {
	ready, err := s.st.RolloutsIn(ctx, model.RolloutReady)
	if err != nil {
		return err
	}
	now := httpx.Now()
	for _, o := range ready {
		if o.StartAt != nil && *o.StartAt <= now {
			if err := s.RolloutCommand(ctx, "system", o.ID, "start", nil); err != nil {
				s.log.Warn("scheduled rollout start", "rollout", o.ID, "err", err)
			}
		}
	}
	running, err := s.st.RolloutsIn(ctx, model.RolloutRunning)
	if err != nil {
		return err
	}
	for _, o := range running {
		if err := s.st.Tx(ctx, "system", func(tx pgx.Tx, now int64) error {
			o, err := s.st.RolloutForUpdate(ctx, tx, o.ID)
			if err != nil || o.Status != model.RolloutRunning {
				return err
			}
			return s.stepRollout(ctx, tx, now, o)
		}); err != nil {
			s.log.Warn("rollout step", "rollout", o.ID, "err", err)
		}
	}
	return nil
}

func (s *Service) stepRollout(ctx context.Context, tx pgx.Tx, now int64, o model.Rollout) error {
	groups, err := s.st.AllGroups(ctx, tx, o.ID)
	if err != nil {
		return err
	}
	pending := false
	for _, g := range groups {
		switch g.Status {
		case model.GroupReady, model.GroupScheduled:
			pending = true
			continue
		case model.GroupRunning:
		default:
			continue
		}
		acts, err := s.st.GroupActions(ctx, tx, g.ID)
		if err != nil {
			return err
		}
		total := g.TotalTargets
		if total == 0 {
			total = int64(len(acts))
		}
		var finished, failed, open int64
		for _, a := range acts {
			switch {
			case a.Status == model.StatusFinished:
				finished++
			case a.Status == model.StatusError:
				failed++
			case a.Active:
				open++
			}
		}
		pct := func(n int64) float64 {
			if total == 0 {
				return 100
			}
			return float64(n) * 100 / float64(total)
		}
		if g.ErrorCondition != nil && failed > 0 && pct(failed) >= threshold(g.ErrorCondition.Expression) {
			if err := s.st.SetGroupStatus(ctx, tx, g.ID, model.GroupError, g.TotalTargets, "system", now); err != nil {
				return err
			}
			if g.ErrorAction != nil && strings.EqualFold(g.ErrorAction.Condition, "PAUSE") {
				o.Status = model.RolloutPaused
				return s.st.UpdateRollout(ctx, tx, "system", now, o)
			}
			continue
		}
		if pct(finished) >= threshold(g.SuccessCondition.Expression) || (open == 0 && len(acts) > 0 && failed == 0) {
			if err := s.st.SetGroupStatus(ctx, tx, g.ID, model.GroupFinished, g.TotalTargets, "system", now); err != nil {
				return err
			}
			if strings.EqualFold(g.SuccessAction.Condition, "NEXTGROUP") {
				started, err := s.startNextGroup(ctx, tx, "system", now, o)
				if err != nil {
					return err
				}
				if started {
					return nil
				}
			}
			continue
		}
		pending = true // still running
	}
	if !pending {
		o.Status = model.RolloutFinished
		return s.st.UpdateRollout(ctx, tx, "system", now, o)
	}
	return nil
}

func threshold(expr string) float64 {
	v, err := strconv.ParseFloat(strings.TrimSpace(expr), 64)
	if err != nil {
		return 100
	}
	return v
}
