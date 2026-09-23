// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Distribution sets: what is assigned to a target, made of software modules.

const dsFrom = "distribution_sets d JOIN ds_types y ON y.id = d.type_id"

const dsCols = "d.id, d.type_id, y.type_key, y.name, d.name, d.version, d.description, d.required_migration_step, " +
	"d.locked, d.valid, d.deleted, (" + dsComplete + "), " +
	"d.created_at, d.created_by, d.last_modified_at, d.last_modified_by"

func scanDS(r pgx.Row) (model.DistributionSet, error) {
	var d model.DistributionSet
	err := r.Scan(&d.ID, &d.TypeID, &d.TypeKey, &d.TypeName, &d.Name, &d.Version, &d.Description,
		&d.RequiredMigrationStep, &d.Locked, &d.Valid, &d.Deleted, &d.Complete,
		&d.CreatedAt, &d.CreatedBy, &d.LastModifiedAt, &d.LastModifiedBy)
	return d, err
}

func (s *Store) withModules(ctx context.Context, q Q, sets []model.DistributionSet) error {
	ids := make([]int64, len(sets))
	for i, d := range sets {
		ids[i] = d.ID
	}
	mods, err := s.ModulesOf(ctx, q, ids)
	if err != nil {
		return err
	}
	for i := range sets {
		sets[i].Modules = mods[sets[i].ID]
		if sets[i].Modules == nil {
			sets[i].Modules = []model.SoftwareModule{}
		}
	}
	return nil
}

// DistributionSets lists sets; extra narrows the list further (the sets with
// a tag, say) with conditions on d.
func (s *Store) DistributionSets(ctx context.Context, page httpx.Page, extra func(a *Args) []string) ([]model.DistributionSet, int64, error) {
	a := &Args{}
	where := []string{"d.tenant = " + a.Bind(s.tenant), "NOT d.deleted"}
	if extra != nil {
		where = append(where, extra(a)...)
	}
	out := []model.DistributionSet{}
	total, err := list(ctx, s.pool, listSpec{
		Select: dsCols, From: dsFrom, Where: where, Fields: dsFields, DefaultSort: "d.id ASC",
	}, a, page, func(r pgx.Rows) error {
		d, err := scanDS(r)
		out = append(out, d)
		return err
	})
	if err != nil {
		return nil, 0, err
	}
	return out, total, s.withModules(ctx, s.pool, out)
}

func (s *Store) DistributionSet(ctx context.Context, q Q, id int64) (model.DistributionSet, error) {
	d, err := scanDS(q.QueryRow(ctx, "SELECT "+dsCols+" FROM "+dsFrom+" WHERE d.tenant = $1 AND d.id = $2", s.tenant, id))
	if err != nil {
		return d, notFound(err, "DistributionSet", id)
	}
	sets := []model.DistributionSet{d}
	err = s.withModules(ctx, q, sets)
	return sets[0], err
}

func (s *Store) CreateDS(ctx context.Context, tx pgx.Tx, user string, now int64, d model.DistributionSet) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO distribution_sets (tenant, type_id, name, version, description, required_migration_step, `+auditCols+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7, $8) RETURNING id`,
		s.tenant, d.TypeID, d.Name, d.Version, d.Description, d.RequiredMigrationStep, now, user).Scan(&id)
	return id, err
}

func (s *Store) UpdateDS(ctx context.Context, tx pgx.Tx, user string, now int64, d model.DistributionSet) error {
	_, err := tx.Exec(ctx, `UPDATE distribution_sets SET name = $3, version = $4, description = $5,
		required_migration_step = $6, locked = $7, valid = $8, last_modified_at = $9, last_modified_by = $10
		WHERE tenant = $1 AND id = $2`,
		s.tenant, d.ID, d.Name, d.Version, d.Description, d.RequiredMigrationStep, d.Locked, d.Valid, now, user)
	return err
}

// Lock marks a set and its modules as locked: from its first assignment on,
// what it contains must not change (implicit.lock.enabled).
func (s *Store) Lock(ctx context.Context, tx pgx.Tx, dsID int64) error {
	if _, err := tx.Exec(ctx, `UPDATE distribution_sets SET locked = TRUE WHERE id = $1 AND NOT locked`, dsID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE software_modules SET locked = TRUE
		WHERE id IN (SELECT sm_id FROM ds_modules WHERE ds_id = $1) AND NOT locked`, dsID)
	return err
}

// DeleteDS removes a set nothing refers to and only hides one that actions,
// targets or rollouts still point at.
func (s *Store) DeleteDS(ctx context.Context, tx pgx.Tx, user string, now int64, id int64) error {
	var used bool
	if err := tx.QueryRow(ctx, `SELECT
		EXISTS (SELECT 1 FROM actions WHERE ds_id = $1) OR
		EXISTS (SELECT 1 FROM targets WHERE assigned_ds_id = $1 OR installed_ds_id = $1) OR
		EXISTS (SELECT 1 FROM rollouts WHERE ds_id = $1)`, id).Scan(&used); err != nil {
		return err
	}
	if used {
		_, err := tx.Exec(ctx, `UPDATE distribution_sets SET deleted = TRUE, last_modified_at = $3, last_modified_by = $4
			WHERE tenant = $1 AND id = $2`, s.tenant, id, now, user)
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM distribution_sets WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return err
}

func (s *Store) AddModule(ctx context.Context, tx pgx.Tx, dsID, smID int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO ds_modules (ds_id, sm_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, dsID, smID)
	return err
}

func (s *Store) RemoveModule(ctx context.Context, tx pgx.Tx, dsID, smID int64) (bool, error) {
	tag, err := tx.Exec(ctx, `DELETE FROM ds_modules WHERE ds_id = $1 AND sm_id = $2`, dsID, smID)
	return tag.RowsAffected() > 0, err
}

// SetsWithModule lists the sets a module belongs to.
func (s *Store) SetsWithModule(ctx context.Context, q Q, smID int64) ([]int64, error) {
	rows, err := q.Query(ctx, `SELECT ds_id FROM ds_modules WHERE sm_id = $1`, smID)
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
