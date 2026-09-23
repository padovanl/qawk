// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Smaller queries the operator's commands need.

// SetActionType changes how an action is handled (soft to forced).
func (s *Store) SetActionType(ctx context.Context, tx pgx.Tx, id int64, typ string, user string, now int64) error {
	_, err := tx.Exec(ctx, `UPDATE actions SET action_type = $2, last_modified_at = $3, last_modified_by = $4
		WHERE tenant = $5 AND id = $1`, id, typ, now, user, s.tenant)
	return err
}

// DeleteClosedActions removes closed actions, and says how many it removed.
// An open action is never deleted: the device is still working on it.
func (s *Store) DeleteClosedActions(ctx context.Context, tx pgx.Tx, ids []int64) (int64, error) {
	tag, err := tx.Exec(ctx, `DELETE FROM actions WHERE tenant = $1 AND id = ANY($2) AND NOT active`, s.tenant, ids)
	return tag.RowsAffected(), err
}

// ActionIDs lists the ids of the actions a query selects, with extra
// conditions on a.
func (s *Store) ActionIDs(ctx context.Context, q string, extra func(a *Args) []string) ([]int64, error) {
	acts, _, err := s.Actions(ctx, httpx.Page{Limit: 1 << 30, Q: q}, extra)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, len(acts))
	for i, a := range acts {
		ids[i] = a.ID
	}
	return ids, nil
}

// ClearAutoAssign takes a set off every filter that hands it out.
func (s *Store) ClearAutoAssign(ctx context.Context, tx pgx.Tx, dsID int64, user string, now int64) error {
	_, err := tx.Exec(ctx, `UPDATE target_filters SET auto_assign_ds_id = NULL, auto_assign_action_type = NULL,
		auto_assign_weight = NULL, confirmation_required = NULL, last_modified_at = $3, last_modified_by = $4
		WHERE tenant = $1 AND auto_assign_ds_id = $2`, s.tenant, dsID, now, user)
	return err
}

// ActiveActionsOfSet lists every open action for a set.
func (s *Store) ActiveActionsOfSet(ctx context.Context, q Q, dsID int64) ([]model.Action, error) {
	rows, err := q.Query(ctx, "SELECT "+actionCols+" FROM "+actionFrom+" WHERE a.tenant = $1 AND a.ds_id = $2 AND a.active",
		s.tenant, dsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Action
	for rows.Next() {
		a, err := scanAction(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// RolloutsOfSet lists the rollouts that deliver a set.
func (s *Store) RolloutsOfSet(ctx context.Context, q Q, dsID int64) ([]model.Rollout, error) {
	rows, err := q.Query(ctx, "SELECT "+rolloutCols+" FROM rollouts r WHERE r.tenant = $1 AND r.ds_id = $2 AND NOT r.deleted",
		s.tenant, dsID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.Rollout
	for rows.Next() {
		o, err := scanRollout(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

// SetStatistics counts, for one set, its rollouts by status, its actions by
// status, and the filters that hand it out.
func (s *Store) SetStatistics(ctx context.Context, dsID int64) (rollouts, actions map[string]int64, autoAssign int64, err error) {
	count := func(sql string) (map[string]int64, error) {
		rows, err := s.pool.Query(ctx, sql, s.tenant, dsID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		out := map[string]int64{}
		for rows.Next() {
			var k string
			var n int64
			if err := rows.Scan(&k, &n); err != nil {
				return nil, err
			}
			out[k] = n
		}
		return out, rows.Err()
	}
	if rollouts, err = count(`SELECT status, count(*) FROM rollouts WHERE tenant = $1 AND ds_id = $2 AND NOT deleted GROUP BY status`); err != nil {
		return
	}
	if actions, err = count(`SELECT status, count(*) FROM actions WHERE tenant = $1 AND ds_id = $2 GROUP BY status`); err != nil {
		return
	}
	err = s.pool.QueryRow(ctx, `SELECT count(*) FROM target_filters WHERE tenant = $1 AND auto_assign_ds_id = $2`,
		s.tenant, dsID).Scan(&autoAssign)
	return
}

// FailedTargetsOfRollout lists the controller ids of the targets whose
// action in that rollout ended in error, for a retry.
func (s *Store) FailedTargetsOfRollout(ctx context.Context, q Q, rolloutID int64) ([]string, error) {
	rows, err := q.Query(ctx, `SELECT DISTINCT t.controller_id FROM actions a JOIN targets t ON t.id = a.target_id
		WHERE a.rollout_id = $1 AND a.status = 'error' ORDER BY 1`, rolloutID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var c string
		if err := rows.Scan(&c); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
