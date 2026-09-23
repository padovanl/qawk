// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Actions and their status history.

const actionFrom = "actions a JOIN targets t ON t.id = a.target_id JOIN distribution_sets d ON d.id = a.ds_id " +
	"LEFT JOIN rollouts r ON r.id = a.rollout_id LEFT JOIN rollout_groups g ON g.id = a.rollout_group_id"

const actionCols = "a.id, a.target_id, t.controller_id, a.ds_id, d.name || ':' || d.version, a.action_type, a.forced_time, " +
	"a.status, a.active, a.weight, a.rollout_id, r.name, a.rollout_group_id, g.name, a.maintenance_schedule, " +
	"a.maintenance_duration, a.maintenance_timezone, a.initiated_by, a.external_ref, a.last_status_code, " +
	"a.created_at, a.created_by, a.last_modified_at, a.last_modified_by"

func scanAction(r pgx.Row) (model.Action, error) {
	var a model.Action
	err := r.Scan(&a.ID, &a.TargetID, &a.ControllerID, &a.DSID, &a.DSLabel, &a.ActionType, &a.ForcedTime,
		&a.Status, &a.Active, &a.Weight, &a.RolloutID, &a.RolloutName, &a.RolloutGroupID, &a.RolloutGroupName,
		&a.MaintenanceSchedule, &a.MaintenanceDuration, &a.MaintenanceTimezone, &a.InitiatedBy, &a.ExternalRef,
		&a.LastStatusCode, &a.CreatedAt, &a.CreatedBy, &a.LastModifiedAt, &a.LastModifiedBy)
	return a, err
}

// Actions lists actions; extra narrows them with conditions on a.
func (s *Store) Actions(ctx context.Context, page httpx.Page, extra func(a *Args) []string) ([]model.Action, int64, error) {
	args := &Args{}
	where := []string{"a.tenant = " + args.Bind(s.tenant)}
	if extra != nil {
		where = append(where, extra(args)...)
	}
	out := []model.Action{}
	total, err := list(ctx, s.pool, listSpec{
		Select: actionCols, From: actionFrom, Where: where, Fields: actionFields, DefaultSort: "a.id ASC",
	}, args, page, func(r pgx.Rows) error {
		a, err := scanAction(r)
		out = append(out, a)
		return err
	})
	return out, total, err
}

func (s *Store) Action(ctx context.Context, q Q, id int64) (model.Action, error) {
	a, err := scanAction(q.QueryRow(ctx, "SELECT "+actionCols+" FROM "+actionFrom+" WHERE a.tenant = $1 AND a.id = $2",
		s.tenant, id))
	return a, notFound(err, "Action", id)
}

// ActionOf returns an action only if it belongs to that target: a device must
// not read, or report on, another device's action.
func (s *Store) ActionOf(ctx context.Context, q Q, targetID, id int64) (model.Action, error) {
	a, err := scanAction(q.QueryRow(ctx, "SELECT "+actionCols+" FROM "+actionFrom+
		" WHERE a.tenant = $1 AND a.id = $2 AND a.target_id = $3", s.tenant, id, targetID))
	return a, notFound(err, "Action", id)
}

// ActiveActions lists a target's open actions, the one to run first first:
// the highest weight, then the oldest -- hawkBit's order.
func (s *Store) ActiveActions(ctx context.Context, q Q, targetID int64) ([]model.Action, error) {
	rows, err := q.Query(ctx, "SELECT "+actionCols+" FROM "+actionFrom+
		" WHERE a.target_id = $1 AND a.active ORDER BY COALESCE(a.weight, 1000) DESC, a.id ASC", targetID)
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

// LastFinished is the target's most recent successfully finished action --
// what installedBase refers to.
func (s *Store) LastFinished(ctx context.Context, q Q, targetID int64) (*model.Action, error) {
	a, err := scanAction(q.QueryRow(ctx, "SELECT "+actionCols+" FROM "+actionFrom+
		" WHERE a.target_id = $1 AND NOT a.active AND a.status = 'finished' AND a.ds_id = t.installed_ds_id ORDER BY a.id DESC LIMIT 1",
		targetID))
	if err == pgx.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (s *Store) CreateAction(ctx context.Context, tx pgx.Tx, user string, now int64, a model.Action) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO actions (tenant, target_id, ds_id, action_type, forced_time, status, active, weight,
		                     rollout_id, rollout_group_id, maintenance_schedule, maintenance_duration,
		                     maintenance_timezone, initiated_by, external_ref, `+auditCols+`)
		VALUES ($1, $2, $3, $4, $5, $6, TRUE, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $15, $16) RETURNING id`,
		s.tenant, a.TargetID, a.DSID, a.ActionType, a.ForcedTime, a.Status, a.Weight, a.RolloutID, a.RolloutGroupID,
		a.MaintenanceSchedule, a.MaintenanceDuration, a.MaintenanceTimezone, a.InitiatedBy, a.ExternalRef, now, user).Scan(&id)
	return id, err
}

// SetAction writes an action's status and whether it is still open.
func (s *Store) SetAction(ctx context.Context, tx pgx.Tx, id int64, status string, active bool, code *int, user string, now int64) error {
	_, err := tx.Exec(ctx, `UPDATE actions SET status = $2, active = $3, last_status_code = COALESCE($4, last_status_code),
		last_modified_at = $5, last_modified_by = $6 WHERE id = $1`, id, status, active, code, now, user)
	return err
}

func (s *Store) SetActionExternalRef(ctx context.Context, tx pgx.Tx, id int64, ref *string) error {
	_, err := tx.Exec(ctx, `UPDATE actions SET external_ref = $2 WHERE id = $1`, id, ref)
	return err
}

func (s *Store) DeleteAction(ctx context.Context, tx pgx.Tx, id int64) error {
	_, err := tx.Exec(ctx, `DELETE FROM actions WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return err
}

// -------------------------------------------------------------------- status

func (s *Store) AddStatus(ctx context.Context, tx pgx.Tx, st model.ActionStatus) (int64, error) {
	if st.Messages == nil {
		st.Messages = []string{}
	}
	var id int64
	err := tx.QueryRow(ctx, `INSERT INTO action_status (action_id, status, occurred_at, reported_at, code, messages)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
		st.ActionID, st.Status, st.OccurredAt, st.ReportedAt, st.Code, st.Messages).Scan(&id)
	return id, err
}

func (s *Store) Statuses(ctx context.Context, actionID int64, page httpx.Page) ([]model.ActionStatus, int64, error) {
	a := &Args{}
	out := []model.ActionStatus{}
	total, err := list(ctx, s.pool, listSpec{
		Select: "s.id, s.action_id, s.status, s.occurred_at, s.reported_at, s.code, s.messages",
		From:   "action_status s", Where: []string{"s.action_id = " + a.Bind(actionID)},
		Fields: actionStatusFields, DefaultSort: "s.id DESC",
	}, a, page, func(r pgx.Rows) error {
		var st model.ActionStatus
		err := r.Scan(&st.ID, &st.ActionID, &st.Status, &st.OccurredAt, &st.ReportedAt, &st.Code, &st.Messages)
		out = append(out, st)
		return err
	})
	return out, total, err
}

// CountStatuses is how many status entries an action has: hawkBit caps them
// (maxStatusEntriesPerAction) and our start script lifts the cap; we keep the
// count so a cap can be enforced if one is configured.
func (s *Store) CountStatuses(ctx context.Context, q Q, actionID int64) (int64, error) {
	var n int64
	err := q.QueryRow(ctx, `SELECT count(*) FROM action_status WHERE action_id = $1`, actionID).Scan(&n)
	return n, err
}
