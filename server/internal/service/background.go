package service

import (
	"context"
	"time"

	"qawk/internal/model"
	"qawk/internal/store"
)

// leaderKey is the advisory lock that elects the instance running the jobs.
const leaderKey = 7272740002

// Run is the background loop: rollouts move on and auto-assignments are
// handed out, every few seconds, until ctx ends.
//
// With several instances of Qawk on one database only one of them runs it:
// each instance keeps trying to become the leader (store.Leader), and the one
// that succeeds runs the jobs until it stops or loses its database
// connection; then another takes over within ten seconds.
func (s *Service) Run(ctx context.Context) {
	for {
		release, alive, leads, err := s.st.Leader(ctx, leaderKey)
		if err != nil && ctx.Err() == nil {
			s.log.Warn("leader election", "err", err)
		}
		if leads {
			s.log.Info("this instance runs the rollout engine and auto-assignment")
			s.leading.Store(true)
			s.lead(ctx, alive)
			s.leading.Store(false)
			release()
			s.log.Info("no longer running the background jobs")
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(10 * time.Second):
		}
	}
}

func (s *Service) lead(ctx context.Context, alive func(context.Context) bool) {
	tick := time.NewTicker(5 * time.Second)
	defer tick.Stop()
	n := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		if !alive(ctx) {
			return
		}
		if err := s.tickRollouts(ctx); err != nil && ctx.Err() == nil {
			s.log.Warn("rollouts", "err", err)
		}
		n++
		if n%2 == 0 {
			if err := s.tickAutoAssign(ctx); err != nil && ctx.Err() == nil {
				s.log.Warn("auto-assignment", "err", err)
			}
			if err := s.tickFleets(ctx); err != nil && ctx.Err() == nil {
				s.log.Warn("fleets", "err", err)
			}
		}
		if n%720 == 1 && s.dir != nil { // hourly
			s.dir.PruneAudit(ctx)
		}
	}
}

// tickAutoAssign gives every filter's set to the targets that match it and
// have never had an action for that set -- so a device where it failed is not
// sent it again every ten seconds, which is hawkBit's rule too.
func (s *Service) tickAutoAssign(ctx context.Context) error {
	filters, err := s.st.AutoAssignFilters(ctx)
	if err != nil {
		return err
	}
	for _, f := range filters {
		dsID := *f.AutoAssignDSID
		ds, err := s.st.DistributionSet(ctx, s.st.DB(), dsID)
		if err != nil || ds.Deleted || !ds.Valid || !ds.Complete {
			continue
		}
		ids, err := s.st.Matching(ctx, s.st.DB(), f.Query, func(a *store.Args) []string {
			d := a.Bind(dsID)
			return append(compatible(ds.TypeID)(a),
				"t.assigned_ds_id IS DISTINCT FROM "+d,
				"NOT EXISTS (SELECT 1 FROM actions x WHERE x.target_id = t.id AND x.ds_id = "+d+")")
		})
		if err != nil {
			s.log.Warn("auto-assignment query", "filter", f.ID, "err", err)
			continue
		}
		if len(ids) == 0 {
			continue
		}
		typ := model.TypeForced
		if f.AutoAssignActionType != nil && *f.AutoAssignActionType != "" {
			typ = *f.AutoAssignActionType
		}
		reqs := make([]AssignRequest, 0, len(ids))
		for _, id := range ids {
			t, err := s.st.TargetByID(ctx, s.st.DB(), id)
			if err != nil {
				continue
			}
			reqs = append(reqs, AssignRequest{ControllerID: t.ControllerID, Type: typ, Weight: f.AutoAssignWeight,
				ConfirmationRequired: f.ConfirmationRequired})
		}
		// the actions are the filter's author's, as they are in hawkBit
		if res, err := s.Assign(ctx, f.LastModifiedBy, dsID, reqs); err != nil {
			s.log.Warn("auto-assignment", "filter", f.ID, "err", err)
		} else if res.Assigned > 0 {
			s.log.Info("auto-assigned", "filter", f.Name, "set", ds.Label(), "targets", res.Assigned)
		}
	}
	return nil
}
