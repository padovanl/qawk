package service

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/store"
)

// Fleets (a Qawk addition): beta, production, staging -- sets of devices that
// should run the same release.
//
// Two things happen in the background, every few seconds, on the instance
// that runs the jobs:
//
//   - a fleet with a rule adopts the devices that match it and are in no
//     fleet yet: a device registering for the first time lands in the right
//     fleet by itself, from what it reports about itself;
//   - a fleet with a release gives it to every member that does not have it
//     and has never been sent it -- the same rule as auto-assignment, so a
//     device where it failed is not sent it again every ten seconds.

// SaveFleet validates a fleet before it is stored: the rule must parse, the
// release must be assignable.
func (s *Service) SaveFleet(ctx context.Context, user string, f model.Fleet) (int64, error) {
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
	id := f.ID
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if f.DSID != nil {
			if _, err := s.checkAssignable(ctx, tx, *f.DSID); err != nil {
				return err
			}
		}
		if f.ID == 0 {
			var err error
			id, err = s.st.CreateFleet(ctx, tx, user, now, f)
			return err
		}
		if _, err := s.st.Fleet(ctx, tx, f.ID); err != nil {
			return err
		}
		return s.st.UpdateFleet(ctx, tx, user, now, f)
	})
	return id, err
}

// SetMembers puts devices into a fleet by hand (fleet nil: out of theirs).
func (s *Service) SetMembers(ctx context.Context, user string, controllerIDs []string, fleet *int64) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if fleet != nil {
			if _, err := s.st.Fleet(ctx, tx, *fleet); err != nil {
				return err
			}
		}
		ids, err := s.st.IDsOf(ctx, tx, controllerIDs)
		if err != nil {
			return err
		}
		return s.st.SetFleet(ctx, tx, ids, fleet)
	})
}

// Promote gives a fleet the release another one runs: "production gets what
// beta has". The members receive it from the next background step.
func (s *Service) Promote(ctx context.Context, user string, to, from int64) (model.Fleet, error) {
	var out model.Fleet
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		src, err := s.st.Fleet(ctx, tx, from)
		if err != nil {
			return err
		}
		if src.DSID == nil {
			return httpx.Validation("fleet " + src.Name + " runs no release: there is nothing to promote")
		}
		dst, err := s.st.Fleet(ctx, tx, to)
		if err != nil {
			return err
		}
		if _, err := s.checkAssignable(ctx, tx, *src.DSID); err != nil {
			return err
		}
		dst.DSID = src.DSID
		if err := s.st.UpdateFleet(ctx, tx, user, now, dst); err != nil {
			return err
		}
		out, err = s.st.Fleet(ctx, tx, to)
		return err
	})
	return out, err
}

func (s *Service) tickFleets(ctx context.Context) error {
	fleets, err := s.st.Fleets(ctx)
	if err != nil {
		return err
	}
	for _, f := range fleets {
		if f.Rule != nil && *f.Rule != "" {
			ids, err := s.st.Matching(ctx, s.st.DB(), *f.Rule, func(a *store.Args) []string {
				return []string{"t.fleet_id IS NULL"}
			})
			if err != nil {
				s.log.Warn("fleet rule", "fleet", f.Name, "err", err)
			} else if len(ids) > 0 {
				fid := f.ID
				if err := s.st.Tx(ctx, "system", func(tx pgx.Tx, now int64) error {
					return s.st.SetFleet(ctx, tx, ids, &fid)
				}); err != nil {
					s.log.Warn("fleet adoption", "fleet", f.Name, "err", err)
				} else {
					s.log.Info("devices joined a fleet by its rule", "fleet", f.Name, "devices", len(ids))
				}
			}
		}
		if f.DSID == nil {
			continue
		}
		dsID := *f.DSID
		ds, err := s.st.DistributionSet(ctx, s.st.DB(), dsID)
		if err != nil || ds.Deleted || !ds.Valid || !ds.Complete {
			continue
		}
		fid := f.ID
		ids, err := s.st.Matching(ctx, s.st.DB(), "", func(a *store.Args) []string {
			d := a.Bind(dsID)
			return append(compatible(ds.TypeID)(a),
				"t.fleet_id = "+a.Bind(fid),
				"t.assigned_ds_id IS DISTINCT FROM "+d,
				"NOT EXISTS (SELECT 1 FROM actions x WHERE x.target_id = t.id AND x.ds_id = "+d+")")
		})
		if err != nil || len(ids) == 0 {
			continue
		}
		reqs := make([]AssignRequest, 0, len(ids))
		for _, id := range ids {
			t, err := s.st.TargetByID(ctx, s.st.DB(), id)
			if err == nil {
				reqs = append(reqs, AssignRequest{ControllerID: t.ControllerID, Type: f.ActionType})
			}
		}
		if res, err := s.Assign(ctx, f.LastModifiedBy, dsID, reqs); err != nil {
			s.log.Warn("fleet release", "fleet", f.Name, "err", err)
		} else if res.Assigned > 0 {
			s.log.Info("fleet release sent", "fleet", f.Name, "set", ds.Label(), "devices", res.Assigned)
		}
	}
	return nil
}
