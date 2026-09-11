package service

import (
	"context"
	"fmt"
	"sort"

	"github.com/jackc/pgx/v5"

	"qawk/internal/model"
)

// AssignRequest is one target in an assignment.
type AssignRequest struct {
	ControllerID         string
	Type                 string // soft, forced (default), timeforced, downloadonly
	ForceTime            int64
	Weight               *int
	MaintenanceSchedule  *string
	MaintenanceDuration  *string
	MaintenanceTimezone  *string
	ConfirmationRequired *bool
	// set by rollouts and auto-assignment, never by the API
	RolloutID *int64
	GroupID   *int64
}

type AssignResult struct {
	Assigned        int
	AlreadyAssigned int
	ActionIDs       []int64
	ControllerIDs   []string // of the actions, same order
}

// DefaultWeight is what hawkBit reports for an action given no weight.
const DefaultWeight = 1000

// Assign sends a distribution set to targets, as hawkBit does:
//
//   - the set must be complete and valid, and every target's type must accept
//     the set's type -- otherwise nothing at all is assigned;
//   - a target that already has this set assigned is counted as
//     alreadyAssigned and gets no new action;
//   - every other target's open actions are cancelled (they go to
//     "canceling": the device is told to stop at its next poll), a new action
//     is created, the set is locked and the target becomes pending.
func (s *Service) Assign(ctx context.Context, user string, dsID int64, reqs []AssignRequest) (AssignResult, error) {
	var res AssignResult
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		ds, err := s.checkAssignable(ctx, tx, dsID)
		if err != nil {
			return err
		}
		targets := make([]model.Target, 0, len(reqs))
		var incompatible []string
		for _, r := range reqs {
			t, err := s.st.TargetForUpdate(ctx, tx, r.ControllerID)
			if err != nil {
				return err
			}
			ok, err := s.st.TargetTypeAccepts(ctx, tx, t.TypeID, ds.TypeID)
			if err != nil {
				return err
			}
			if !ok {
				name := ""
				if t.TypeName != nil {
					name = *t.TypeName
				}
				incompatible = append(incompatible, name)
			}
			targets = append(targets, t)
		}
		if len(incompatible) > 0 {
			sort.Strings(incompatible)
			return errIncompatible(dedupe(incompatible), ds.TypeName)
		}
		if s.st.ConfigBool(ctx, "implicit.lock.enabled") {
			if err := s.st.Lock(ctx, tx, ds.ID); err != nil {
				return err
			}
		}
		confirmFlow := s.st.ConfigBool(ctx, "user.confirmation.flow.enabled")
		for i, t := range targets {
			if t.AssignedDSID != nil && *t.AssignedDSID == ds.ID {
				res.AlreadyAssigned++
				continue
			}
			id, err := s.createAction(ctx, tx, user, now, t, ds, reqs[i], confirmFlow)
			if err != nil {
				return err
			}
			res.Assigned++
			res.ActionIDs = append(res.ActionIDs, id)
			res.ControllerIDs = append(res.ControllerIDs, t.ControllerID)
		}
		return nil
	})
	return res, err
}

// checkAssignable loads a set and refuses it if it cannot be assigned.
func (s *Service) checkAssignable(ctx context.Context, tx pgx.Tx, dsID int64) (model.DistributionSet, error) {
	ds, err := s.st.DistributionSet(ctx, tx, dsID)
	if err != nil {
		return ds, err
	}
	if ds.Deleted {
		return ds, errInvalidDS(ds.Label())
	}
	if !ds.Valid {
		return ds, errInvalidDS(ds.Label())
	}
	if !ds.Complete {
		mandatory, err := s.st.DSTypeModuleTypes(ctx, tx, ds.TypeID, true)
		if err != nil {
			return ds, err
		}
		have := map[int64]bool{}
		for _, m := range ds.Modules {
			have[m.TypeID] = true
		}
		var missing []string
		for _, t := range mandatory {
			if !have[t.ID] {
				missing = append(missing, t.Name)
			}
		}
		return ds, errIncomplete(ds.TypeName, missing)
	}
	return ds, nil
}

func (s *Service) createAction(ctx context.Context, tx pgx.Tx, user string, now int64, t model.Target,
	ds model.DistributionSet, r AssignRequest, confirmFlow bool) (int64, error) {
	if err := validateWindow(r, now); err != nil {
		return 0, err
	}

	// What the target was doing is obsolete now. It is not closed here: the
	// device is told to cancel, and closes it itself when it has.
	actives, err := s.st.ActiveActions(ctx, tx, t.ID)
	if err != nil {
		return 0, err
	}
	for _, a := range actives {
		if a.Status == model.StatusCanceling {
			continue
		}
		if err := s.st.SetAction(ctx, tx, a.ID, model.StatusCanceling, true, nil, user, now); err != nil {
			return 0, err
		}
		if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: model.StatusCanceling,
			OccurredAt: now, ReportedAt: now, Messages: []string{MsgCancelObsolete}}); err != nil {
			return 0, err
		}
	}

	typ := r.Type
	if typ == "" {
		typ = model.TypeForced
	}
	weight := r.Weight
	if weight == nil {
		w := DefaultWeight
		weight = &w
	}
	status := model.StatusRunning
	needsConfirmation := confirmFlow && (r.ConfirmationRequired == nil || *r.ConfirmationRequired) && !t.AutoConfirmActive
	if needsConfirmation {
		status = model.StatusWaitForConfirmation
	}
	id, err := s.st.CreateAction(ctx, tx, user, now, model.Action{
		TargetID: t.ID, DSID: ds.ID, ActionType: typ, ForcedTime: r.ForceTime, Status: status, Weight: weight,
		RolloutID: r.RolloutID, RolloutGroupID: r.GroupID, MaintenanceSchedule: r.MaintenanceSchedule,
		MaintenanceDuration: r.MaintenanceDuration, MaintenanceTimezone: r.MaintenanceTimezone, InitiatedBy: user,
	})
	if err != nil {
		return 0, err
	}
	msgs := []model.ActionStatus{{ActionID: id, Status: model.StatusRunning, OccurredAt: now, ReportedAt: now,
		Messages: []string{fmt.Sprintf(MsgAssigned, user)}}}
	if needsConfirmation {
		msgs = append(msgs, model.ActionStatus{ActionID: id, Status: model.StatusWaitForConfirmation, OccurredAt: now,
			ReportedAt: now, Messages: []string{MsgWaitForConfirmation}})
	} else if confirmFlow && t.AutoConfirmActive {
		initiator := ""
		if t.AutoConfirmInitiator != nil {
			initiator = *t.AutoConfirmInitiator
		}
		msgs = append(msgs, model.ActionStatus{ActionID: id, Status: model.StatusRunning, OccurredAt: now,
			ReportedAt: now, Messages: []string{fmt.Sprintf(MsgAutoConfirmed, initiator)}})
	}
	for _, m := range msgs {
		if _, err := s.st.AddStatus(ctx, tx, m); err != nil {
			return 0, err
		}
	}
	dsID := ds.ID
	return id, s.st.SetState(ctx, tx, t.ID, &dsID, t.InstalledDSID, nil, model.UpdatePending)
}

// settle recomputes a target's assignment state after an action closed:
// pending on the newest open action's set if there is one, otherwise back to
// what it runs -- in_sync, or registered if it has never installed anything.
func (s *Service) settle(ctx context.Context, tx pgx.Tx, targetID int64, installed *int64, installedAt *int64, failed bool) error {
	actives, err := s.st.ActiveActions(ctx, tx, targetID)
	if err != nil {
		return err
	}
	if len(actives) > 0 {
		newest := actives[0]
		for _, a := range actives {
			if a.ID > newest.ID {
				newest = a
			}
		}
		ds := newest.DSID
		return s.st.SetState(ctx, tx, targetID, &ds, installed, installedAt, model.UpdatePending)
	}
	status := model.UpdateInSync
	if installed == nil {
		status = model.UpdateRegistered
	}
	if failed {
		status = model.UpdateError
		t, err := s.st.TargetByID(ctx, tx, targetID)
		if err != nil {
			return err
		}
		// the set stays assigned: the operator sees what failed, and a retry
		// is an assignment of the same set
		return s.st.SetState(ctx, tx, targetID, t.AssignedDSID, installed, installedAt, status)
	}
	return s.st.SetState(ctx, tx, targetID, installed, installed, installedAt, status)
}

func dedupe(xs []string) []string {
	out := xs[:0]
	for i, x := range xs {
		if i == 0 || x != xs[i-1] {
			out = append(out, x)
		}
	}
	return out
}
