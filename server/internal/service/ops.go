// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package service

import (
	"context"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// The operator's other commands.

// SwitchToForced turns a soft (or time-forced) action into a forced one: the
// device installs at its next poll instead of when it sees fit.
func (s *Service) SwitchToForced(ctx context.Context, user, controllerID string, actionID int64) (model.Action, error) {
	var out model.Action
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		t, err := s.st.TargetForUpdate(ctx, tx, controllerID)
		if err != nil {
			return err
		}
		a, err := s.st.ActionOf(ctx, tx, t.ID, actionID)
		if err != nil {
			return err
		}
		if !a.Active {
			return httpx.Custom(400, "hawkbit.server.error.action.notactive", repoExc+"ActionNotActiveException",
				fmt.Sprintf("Action %d is closed", a.ID))
		}
		if a.ActionType != model.TypeForced {
			if err := s.st.SetActionType(ctx, tx, a.ID, model.TypeForced, user, now); err != nil {
				return err
			}
		}
		out, err = s.st.ActionOf(ctx, tx, t.ID, actionID)
		return err
	})
	return out, err
}

// InvalidateSet marks a set as no longer assignable and, as asked, cancels
// what is delivering it: its auto-assignments always, its rollouts if
// cancelRollouts, its open actions softly ("soft") or at once ("force").
func (s *Service) InvalidateSet(ctx context.Context, user string, dsID int64, cancel string, cancelRollouts bool) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		ds, err := s.st.DistributionSet(ctx, tx, dsID)
		if err != nil {
			return err
		}
		ds.Valid = false
		if err := s.st.UpdateDS(ctx, tx, user, now, ds); err != nil {
			return err
		}
		if err := s.st.ClearAutoAssign(ctx, tx, dsID, user, now); err != nil {
			return err
		}
		if cancelRollouts || strings.EqualFold(cancel, "soft") || strings.EqualFold(cancel, "force") {
			ros, err := s.st.RolloutsOfSet(ctx, tx, dsID)
			if err != nil {
				return err
			}
			for _, o := range ros {
				if o.Status == model.RolloutFinished || o.Status == model.RolloutStopped {
					continue
				}
				o.Status = model.RolloutStopped
				if err := s.st.UpdateRollout(ctx, tx, user, now, o); err != nil {
					return err
				}
			}
		}
		mode := strings.ToLower(cancel)
		if mode != "soft" && mode != "force" {
			return nil
		}
		acts, err := s.st.ActiveActionsOfSet(ctx, tx, dsID)
		if err != nil {
			return err
		}
		for _, a := range acts {
			if mode == "force" {
				if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: model.StatusCanceled,
					OccurredAt: now, ReportedAt: now, Messages: []string{MsgForceQuit}}); err != nil {
					return err
				}
				if err := s.st.SetAction(ctx, tx, a.ID, model.StatusCanceled, false, nil, user, now); err != nil {
					return err
				}
				t, err := s.st.TargetByID(ctx, tx, a.TargetID)
				if err != nil {
					return err
				}
				if err := s.settle(ctx, tx, t.ID, t.InstalledDSID, nil, false); err != nil {
					return err
				}
				continue
			}
			if a.Status == model.StatusCanceling {
				continue
			}
			if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: model.StatusCanceling,
				OccurredAt: now, ReportedAt: now, Messages: []string{MsgCancelRequested}}); err != nil {
				return err
			}
			if err := s.st.SetAction(ctx, tx, a.ID, model.StatusCanceling, true, nil, user, now); err != nil {
				return err
			}
		}
		return nil
	})
}

// StopRollout stops a rollout for good: the groups not started never will
// be, and what is still open is cancelled.
func (s *Service) StopRollout(ctx context.Context, user string, id int64) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		o, err := s.st.RolloutForUpdate(ctx, tx, id)
		if err != nil {
			return err
		}
		switch o.Status {
		case model.RolloutRunning, model.RolloutPaused, model.RolloutReady, model.RolloutWaitingForApproval:
		default:
			return errRolloutState(o, "running, paused or ready")
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
				if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: model.StatusCanceling,
					OccurredAt: now, ReportedAt: now, Messages: []string{MsgCancelRequested}}); err != nil {
					return err
				}
				if err := s.st.SetAction(ctx, tx, a.ID, model.StatusCanceling, true, nil, user, now); err != nil {
					return err
				}
			}
			if g.Status == model.GroupReady || g.Status == model.GroupScheduled || g.Status == model.GroupRunning {
				if err := s.st.SetGroupStatus(ctx, tx, g.ID, model.GroupFinished, g.TotalTargets, user, now); err != nil {
					return err
				}
			}
		}
		o.Status = model.RolloutStopped
		return s.st.UpdateRollout(ctx, tx, user, now, o)
	})
}

// RetryRollout creates a new rollout, of one group, for the targets on which
// the given one failed -- hawkBit's retry.
func (s *Service) RetryRollout(ctx context.Context, user string, id int64) (int64, error) {
	o, err := s.st.Rollout(ctx, s.st.DB(), id)
	if err != nil {
		return 0, err
	}
	if o.Status != model.RolloutFinished && o.Status != model.RolloutStopped {
		return 0, errRolloutState(o, "finished or stopped")
	}
	failed, err := s.st.FailedTargetsOfRollout(ctx, s.st.DB(), id)
	if err != nil {
		return 0, err
	}
	if len(failed) == 0 {
		return 0, httpx.Validation("no target failed in this rollout: there is nothing to retry")
	}
	quoted := make([]string, len(failed))
	for i, c := range failed {
		quoted[i] = `"` + strings.ReplaceAll(c, `"`, `\"`) + `"`
	}
	return s.CreateRollout(ctx, user, RolloutDef{
		Name: o.Name + "_retry", Description: o.Description, DSID: o.DSID,
		TargetFilterQuery: "controllerId=in=(" + strings.Join(quoted, ",") + ")",
		ActionType:        o.ActionType, ForceTime: o.ForcedTime, Weight: o.Weight, AmountGroups: 1,
		ConfirmationRequired: o.ConfirmationRequired,
	})
}

// DeleteActions removes closed actions; an open one cannot be deleted, it
// must be cancelled first.
func (s *Service) DeleteActions(ctx context.Context, user string, ids []int64) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		for _, id := range ids {
			a, err := s.st.Action(ctx, tx, id)
			if err != nil {
				return err
			}
			if a.Active {
				return httpx.Custom(400, "hawkbit.server.error.action.stillactive", repoExc+"ActionStillActiveException",
					fmt.Sprintf("Action %d is still open: cancel it before deleting it", id))
			}
		}
		_, err := s.st.DeleteClosedActions(ctx, tx, ids)
		return err
	})
}
