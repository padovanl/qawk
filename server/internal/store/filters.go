// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Target filter queries: a saved query, optionally with a set that every
// target it matches receives automatically.

const filterCols = "f.id, f.name, f.query, f.auto_assign_ds_id, f.auto_assign_action_type, f.auto_assign_weight, " +
	"f.confirmation_required, f.created_at, f.created_by, f.last_modified_at, f.last_modified_by"

func scanFilter(r pgx.Row) (model.TargetFilter, error) {
	var f model.TargetFilter
	err := r.Scan(&f.ID, &f.Name, &f.Query, &f.AutoAssignDSID, &f.AutoAssignActionType, &f.AutoAssignWeight,
		&f.ConfirmationRequired, &f.CreatedAt, &f.CreatedBy, &f.LastModifiedAt, &f.LastModifiedBy)
	return f, err
}

func (s *Store) TargetFilters(ctx context.Context, page httpx.Page, extra func(a *Args) []string) ([]model.TargetFilter, int64, error) {
	a := &Args{}
	where := []string{"f.tenant = " + a.Bind(s.tenant)}
	if extra != nil {
		where = append(where, extra(a)...)
	}
	out := []model.TargetFilter{}
	total, err := list(ctx, s.pool, listSpec{
		Select: filterCols, From: "target_filters f", Where: where,
		Fields: filterFields, DefaultSort: "f.id ASC",
	}, a, page, func(r pgx.Rows) error {
		f, err := scanFilter(r)
		out = append(out, f)
		return err
	})
	return out, total, err
}

func (s *Store) TargetFilter(ctx context.Context, q Q, id int64) (model.TargetFilter, error) {
	f, err := scanFilter(q.QueryRow(ctx, "SELECT "+filterCols+" FROM target_filters f WHERE f.tenant = $1 AND f.id = $2",
		s.tenant, id))
	return f, notFound(err, "TargetFilterQuery", id)
}

func (s *Store) CreateTargetFilter(ctx context.Context, tx pgx.Tx, user string, now int64, f model.TargetFilter) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `INSERT INTO target_filters (tenant, name, query, `+auditCols+`)
		VALUES ($1, $2, $3, $4, $5, $4, $5) RETURNING id`, s.tenant, f.Name, f.Query, now, user).Scan(&id)
	return id, err
}

func (s *Store) UpdateTargetFilter(ctx context.Context, tx pgx.Tx, user string, now int64, f model.TargetFilter) error {
	_, err := tx.Exec(ctx, `UPDATE target_filters SET name = $3, query = $4, auto_assign_ds_id = $5,
		auto_assign_action_type = $6, auto_assign_weight = $7, confirmation_required = $8,
		last_modified_at = $9, last_modified_by = $10 WHERE tenant = $1 AND id = $2`,
		s.tenant, f.ID, f.Name, f.Query, f.AutoAssignDSID, f.AutoAssignActionType, f.AutoAssignWeight,
		f.ConfirmationRequired, now, user)
	return err
}

func (s *Store) DeleteTargetFilter(ctx context.Context, tx pgx.Tx, id int64) error {
	tag, err := tx.Exec(ctx, `DELETE FROM target_filters WHERE tenant = $1 AND id = $2`, s.tenant, id)
	if err == nil && tag.RowsAffected() == 0 {
		return httpx.NotFound("TargetFilterQuery", id)
	}
	return err
}

// AutoAssignFilters lists the filters that carry a set to hand out.
func (s *Store) AutoAssignFilters(ctx context.Context) ([]model.TargetFilter, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+filterCols+` FROM target_filters f
		WHERE f.tenant = $1 AND f.auto_assign_ds_id IS NOT NULL ORDER BY f.id`, s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []model.TargetFilter
	for rows.Next() {
		f, err := scanFilter(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}
