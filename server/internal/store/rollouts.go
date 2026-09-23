// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Rollouts and their deployment groups.

const rolloutCols = "r.id, r.name, r.description, r.ds_id, " +
	"(SELECT x.name || ':' || x.version FROM distribution_sets x WHERE x.id = r.ds_id), " +
	"r.target_filter_query, r.action_type, r.forced_time, r.weight, r.status, r.dynamic, r.start_at, " +
	"r.confirmation_required, r.approval_decided_by, r.approval_remark, r.total_targets, r.deleted, " +
	"r.created_at, r.created_by, r.last_modified_at, r.last_modified_by"

func scanRollout(r pgx.Row) (model.Rollout, error) {
	var o model.Rollout
	err := r.Scan(&o.ID, &o.Name, &o.Description, &o.DSID, &o.DSLabel, &o.TargetFilterQuery, &o.ActionType,
		&o.ForcedTime, &o.Weight, &o.Status, &o.Dynamic, &o.StartAt, &o.ConfirmationRequired, &o.ApprovalDecidedBy,
		&o.ApprovalRemark, &o.TotalTargets, &o.Deleted, &o.CreatedAt, &o.CreatedBy, &o.LastModifiedAt, &o.LastModifiedBy)
	return o, err
}

func (s *Store) Rollouts(ctx context.Context, page httpx.Page) ([]model.Rollout, int64, error) {
	a := &Args{}
	out := []model.Rollout{}
	total, err := list(ctx, s.pool, listSpec{
		Select: rolloutCols, From: "rollouts r", Where: []string{"r.tenant = " + a.Bind(s.tenant), "NOT r.deleted"},
		Fields: rolloutFields, DefaultSort: "r.id ASC",
	}, a, page, func(r pgx.Rows) error {
		o, err := scanRollout(r)
		out = append(out, o)
		return err
	})
	return out, total, err
}

func (s *Store) Rollout(ctx context.Context, q Q, id int64) (model.Rollout, error) {
	o, err := scanRollout(q.QueryRow(ctx, "SELECT "+rolloutCols+" FROM rollouts r WHERE r.tenant = $1 AND r.id = $2 AND NOT r.deleted",
		s.tenant, id))
	return o, notFound(err, "Rollout", id)
}

func (s *Store) RolloutForUpdate(ctx context.Context, tx pgx.Tx, id int64) (model.Rollout, error) {
	o, err := scanRollout(tx.QueryRow(ctx, "SELECT "+rolloutCols+" FROM rollouts r WHERE r.tenant = $1 AND r.id = $2 AND NOT r.deleted FOR UPDATE",
		s.tenant, id))
	return o, notFound(err, "Rollout", id)
}

// RolloutsIn lists the rollouts in the given states, for the scheduler.
func (s *Store) RolloutsIn(ctx context.Context, statuses ...string) ([]model.Rollout, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+rolloutCols+" FROM rollouts r WHERE r.tenant = $1 AND NOT r.deleted AND r.status = ANY($2) ORDER BY r.id",
		s.tenant, statuses)
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

func (s *Store) CreateRollout(ctx context.Context, tx pgx.Tx, user string, now int64, o model.Rollout) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO rollouts (tenant, name, description, ds_id, target_filter_query, action_type, forced_time, weight,
		                      status, dynamic, start_at, confirmation_required, `+auditCols+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $13, $14) RETURNING id`,
		s.tenant, o.Name, o.Description, o.DSID, o.TargetFilterQuery, o.ActionType, o.ForcedTime, o.Weight,
		o.Status, o.Dynamic, o.StartAt, o.ConfirmationRequired, now, user).Scan(&id)
	return id, err
}

func (s *Store) UpdateRollout(ctx context.Context, tx pgx.Tx, user string, now int64, o model.Rollout) error {
	_, err := tx.Exec(ctx, `UPDATE rollouts SET name = $3, description = $4, status = $5, total_targets = $6,
		approval_decided_by = $7, approval_remark = $8, start_at = $9, last_modified_at = $10, last_modified_by = $11
		WHERE tenant = $1 AND id = $2`,
		s.tenant, o.ID, o.Name, o.Description, o.Status, o.TotalTargets, o.ApprovalDecidedBy, o.ApprovalRemark,
		o.StartAt, now, user)
	return err
}

// DeleteRollout hides the rollout; its actions keep pointing at it.
func (s *Store) DeleteRollout(ctx context.Context, tx pgx.Tx, user string, now int64, id int64) error {
	_, err := tx.Exec(ctx, `UPDATE rollouts SET deleted = TRUE, status = 'deleted', last_modified_at = $3,
		last_modified_by = $4 WHERE tenant = $1 AND id = $2`, s.tenant, id, now, user)
	return err
}

// ------------------------------------------------------------------ groups

const groupCols = "g.id, g.rollout_id, g.position, g.name, g.description, g.status, g.target_filter_query, " +
	"g.target_percentage, g.success_condition, g.success_condition_exp, g.success_action, g.success_action_exp, " +
	"g.error_condition, g.error_condition_exp, g.error_action, g.error_action_exp, g.confirmation_required, " +
	"g.dynamic, g.total_targets, g.created_at, g.created_by, g.last_modified_at, g.last_modified_by"

func scanGroup(r pgx.Row) (model.RolloutGroup, error) {
	var g model.RolloutGroup
	var ec, ece, ea, eae *string
	err := r.Scan(&g.ID, &g.RolloutID, &g.Position, &g.Name, &g.Description, &g.Status, &g.TargetFilterQuery,
		&g.TargetPercentage, &g.SuccessCondition.Condition, &g.SuccessCondition.Expression,
		&g.SuccessAction.Condition, &g.SuccessAction.Expression, &ec, &ece, &ea, &eae, &g.ConfirmationRequired,
		&g.Dynamic, &g.TotalTargets, &g.CreatedAt, &g.CreatedBy, &g.LastModifiedAt, &g.LastModifiedBy)
	if ec != nil {
		g.ErrorCondition = &model.Condition{Condition: *ec, Expression: deref(ece)}
	}
	if ea != nil {
		g.ErrorAction = &model.Condition{Condition: *ea, Expression: deref(eae)}
	}
	return g, err
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func (s *Store) Groups(ctx context.Context, rolloutID int64, page httpx.Page) ([]model.RolloutGroup, int64, error) {
	a := &Args{}
	out := []model.RolloutGroup{}
	total, err := list(ctx, s.pool, listSpec{
		Select: groupCols, From: "rollout_groups g", Where: []string{"g.rollout_id = " + a.Bind(rolloutID)},
		Fields: rolloutGroupFields, DefaultSort: "g.position ASC",
	}, a, page, func(r pgx.Rows) error {
		g, err := scanGroup(r)
		out = append(out, g)
		return err
	})
	return out, total, err
}

// AllGroups returns a rollout's groups in order, for the scheduler.
func (s *Store) AllGroups(ctx context.Context, q Q, rolloutID int64) ([]model.RolloutGroup, error) {
	rows, err := q.Query(ctx, "SELECT "+groupCols+" FROM rollout_groups g WHERE g.rollout_id = $1 ORDER BY g.position", rolloutID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.RolloutGroup
	for rows.Next() {
		g, err := scanGroup(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

func (s *Store) Group(ctx context.Context, q Q, rolloutID, id int64) (model.RolloutGroup, error) {
	g, err := scanGroup(q.QueryRow(ctx, "SELECT "+groupCols+" FROM rollout_groups g WHERE g.rollout_id = $1 AND g.id = $2",
		rolloutID, id))
	return g, notFound(err, "RolloutGroup", id)
}

func (s *Store) CreateGroup(ctx context.Context, tx pgx.Tx, user string, now int64, g model.RolloutGroup) (int64, error) {
	var ec, ece, ea, eae *string
	if g.ErrorCondition != nil {
		ec, ece = &g.ErrorCondition.Condition, &g.ErrorCondition.Expression
	}
	if g.ErrorAction != nil {
		ea, eae = &g.ErrorAction.Condition, &g.ErrorAction.Expression
	}
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO rollout_groups (rollout_id, position, name, description, status, target_filter_query,
		       target_percentage, success_condition, success_condition_exp, success_action, success_action_exp,
		       error_condition, error_condition_exp, error_action, error_action_exp, confirmation_required,
		       dynamic, total_targets, `+auditCols+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $19, $20)
		RETURNING id`,
		g.RolloutID, g.Position, g.Name, g.Description, g.Status, g.TargetFilterQuery, g.TargetPercentage,
		g.SuccessCondition.Condition, g.SuccessCondition.Expression, g.SuccessAction.Condition, g.SuccessAction.Expression,
		ec, ece, ea, eae, g.ConfirmationRequired, g.Dynamic, g.TotalTargets, now, user).Scan(&id)
	return id, err
}

func (s *Store) SetGroupStatus(ctx context.Context, tx pgx.Tx, id int64, status string, total int64, user string, now int64) error {
	_, err := tx.Exec(ctx, `UPDATE rollout_groups SET status = $2, total_targets = $3, last_modified_at = $4,
		last_modified_by = $5 WHERE id = $1`, id, status, total, now, user)
	return err
}

func (s *Store) AddGroupTargets(ctx context.Context, tx pgx.Tx, groupID int64, targetIDs []int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO rollout_group_targets (group_id, target_id)
		SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING`, groupID, targetIDs)
	return err
}

func (s *Store) GroupTargetIDs(ctx context.Context, q Q, groupID int64) ([]int64, error) {
	rows, err := q.Query(ctx, `SELECT target_id FROM rollout_group_targets WHERE group_id = $1 ORDER BY target_id`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// InGroup is the condition "belongs to this rollout group", for the target
// list of a group.
func InGroup(groupID int64) func(a *Args) []string {
	return func(a *Args) []string {
		return []string{"EXISTS (SELECT 1 FROM rollout_group_targets rgt WHERE rgt.group_id = " + a.Bind(groupID) +
			" AND rgt.target_id = t.id)"}
	}
}

// TargetsInRollout lists the ids of the targets already in any group of the
// rollout, so that a target is never put in two groups of the same rollout.
func (s *Store) TargetsInRollout(ctx context.Context, q Q, rolloutID int64) (map[int64]bool, error) {
	rows, err := q.Query(ctx, `SELECT rgt.target_id FROM rollout_group_targets rgt
		JOIN rollout_groups g ON g.id = rgt.group_id WHERE g.rollout_id = $1`, rolloutID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]bool{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// ------------------------------------------------------------------ counts

// StatusCounts counts a rollout's (or one group's) targets by what happened
// to them, in the categories hawkBit's totalTargetsPerStatus uses:
// notstarted (no action yet), scheduled, running, finished, error, cancelled.
func (s *Store) StatusCounts(ctx context.Context, q Q, rolloutID int64, groupID *int64) (map[string]int64, error) {
	out := map[string]int64{"running": 0, "notstarted": 0, "scheduled": 0, "cancelled": 0, "finished": 0, "error": 0}
	var rows pgx.Rows
	var err error
	const cat = `CASE
		WHEN a.id IS NULL THEN 'notstarted'
		WHEN a.status = 'scheduled' THEN 'scheduled'
		WHEN a.status = 'finished' THEN 'finished'
		WHEN a.status = 'error' THEN 'error'
		WHEN a.status IN ('canceled') THEN 'cancelled'
		ELSE 'running' END`
	if groupID == nil {
		rows, err = q.Query(ctx, `SELECT `+cat+`, count(*) FROM rollout_group_targets rgt
			JOIN rollout_groups g ON g.id = rgt.group_id
			LEFT JOIN actions a ON a.rollout_group_id = g.id AND a.target_id = rgt.target_id
			WHERE g.rollout_id = $1 GROUP BY 1`, rolloutID)
	} else {
		rows, err = q.Query(ctx, `SELECT `+cat+`, count(*) FROM rollout_group_targets rgt
			LEFT JOIN actions a ON a.rollout_group_id = rgt.group_id AND a.target_id = rgt.target_id
			WHERE rgt.group_id = $1 GROUP BY 1`, *groupID)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()
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

// GroupActions lists a group's actions, for the scheduler to decide whether
// the group succeeded, failed or is still going.
func (s *Store) GroupActions(ctx context.Context, q Q, groupID int64) ([]model.Action, error) {
	rows, err := q.Query(ctx, "SELECT "+actionCols+" FROM "+actionFrom+" WHERE a.rollout_group_id = $1", groupID)
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
