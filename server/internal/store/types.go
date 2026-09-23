// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Software module types, distribution set types and target types.

const auditCols = "created_at, created_by, last_modified_at, last_modified_by"

// ------------------------------------------------------ software module types

const smTypeCols = "y.id, y.type_key, y.name, y.description, y.colour, y.max_assignments, y.min_artifacts, y.deleted, " +
	"y.created_at, y.created_by, y.last_modified_at, y.last_modified_by"

func scanSMType(r pgx.Row) (model.SMType, error) {
	var t model.SMType
	err := r.Scan(&t.ID, &t.Key, &t.Name, &t.Description, &t.Colour, &t.MaxAssignments, &t.MinArtifacts, &t.Deleted,
		&t.CreatedAt, &t.CreatedBy, &t.LastModifiedAt, &t.LastModifiedBy)
	return t, err
}

func (s *Store) SMTypes(ctx context.Context, page httpx.Page) ([]model.SMType, int64, error) {
	a := &Args{}
	out := []model.SMType{}
	total, err := list(ctx, s.pool, listSpec{
		Select: smTypeCols, From: "sm_types y",
		Where:  []string{"y.tenant = " + a.Bind(s.tenant), "NOT y.deleted"},
		Fields: smTypeFields, DefaultSort: "y.id ASC",
	}, a, page, func(r pgx.Rows) error {
		t, err := scanSMType(r)
		out = append(out, t)
		return err
	})
	return out, total, err
}

func (s *Store) SMType(ctx context.Context, q Q, id int64) (model.SMType, error) {
	t, err := scanSMType(q.QueryRow(ctx, "SELECT "+smTypeCols+" FROM sm_types y WHERE y.tenant = $1 AND y.id = $2", s.tenant, id))
	return t, notFound(err, "SoftwareModuleType", id)
}

func (s *Store) SMTypeByKey(ctx context.Context, q Q, key string) (model.SMType, error) {
	t, err := scanSMType(q.QueryRow(ctx,
		"SELECT "+smTypeCols+" FROM sm_types y WHERE y.tenant = $1 AND y.type_key = $2 AND NOT y.deleted", s.tenant, key))
	return t, notFound(err, "SoftwareModuleType", key)
}

func (s *Store) CreateSMType(ctx context.Context, tx pgx.Tx, user string, now int64, t model.SMType) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO sm_types (tenant, type_key, name, description, colour, max_assignments, min_artifacts, `+auditCols+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $9) RETURNING id`,
		s.tenant, t.Key, t.Name, t.Description, t.Colour, t.MaxAssignments, t.MinArtifacts, now, user).Scan(&id)
	return id, err
}

func (s *Store) UpdateSMType(ctx context.Context, tx pgx.Tx, user string, now int64, t model.SMType) error {
	_, err := tx.Exec(ctx, `UPDATE sm_types SET description = $3, colour = $4, last_modified_at = $5, last_modified_by = $6
		WHERE tenant = $1 AND id = $2`, s.tenant, t.ID, t.Description, t.Colour, now, user)
	return err
}

// DeleteSMType deletes a type nobody uses, and only hides one that modules
// still point at -- their history needs it.
func (s *Store) DeleteSMType(ctx context.Context, tx pgx.Tx, id int64) error {
	var used bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM software_modules WHERE type_id = $1)`, id).Scan(&used); err != nil {
		return err
	}
	if used {
		_, err := tx.Exec(ctx, `UPDATE sm_types SET deleted = TRUE WHERE tenant = $1 AND id = $2`, s.tenant, id)
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM sm_types WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return err
}

// ---------------------------------------------------- distribution set types

const dsTypeCols = "y.id, y.type_key, y.name, y.description, y.colour, y.deleted, " +
	"y.created_at, y.created_by, y.last_modified_at, y.last_modified_by"

func scanDSType(r pgx.Row) (model.DSType, error) {
	var t model.DSType
	err := r.Scan(&t.ID, &t.Key, &t.Name, &t.Description, &t.Colour, &t.Deleted,
		&t.CreatedAt, &t.CreatedBy, &t.LastModifiedAt, &t.LastModifiedBy)
	return t, err
}

func (s *Store) DSTypes(ctx context.Context, page httpx.Page) ([]model.DSType, int64, error) {
	a := &Args{}
	out := []model.DSType{}
	total, err := list(ctx, s.pool, listSpec{
		Select: dsTypeCols, From: "ds_types y",
		Where:  []string{"y.tenant = " + a.Bind(s.tenant), "NOT y.deleted"},
		Fields: dsTypeFields, DefaultSort: "y.id ASC",
	}, a, page, func(r pgx.Rows) error {
		t, err := scanDSType(r)
		out = append(out, t)
		return err
	})
	return out, total, err
}

func (s *Store) DSType(ctx context.Context, q Q, id int64) (model.DSType, error) {
	t, err := scanDSType(q.QueryRow(ctx, "SELECT "+dsTypeCols+" FROM ds_types y WHERE y.tenant = $1 AND y.id = $2", s.tenant, id))
	return t, notFound(err, "DistributionSetType", id)
}

func (s *Store) DSTypeByKey(ctx context.Context, q Q, key string) (model.DSType, error) {
	t, err := scanDSType(q.QueryRow(ctx,
		"SELECT "+dsTypeCols+" FROM ds_types y WHERE y.tenant = $1 AND y.type_key = $2 AND NOT y.deleted", s.tenant, key))
	return t, notFound(err, "DistributionSetType", key)
}

func (s *Store) CreateDSType(ctx context.Context, tx pgx.Tx, user string, now int64, t model.DSType) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO ds_types (tenant, type_key, name, description, colour, `+auditCols+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7) RETURNING id`,
		s.tenant, t.Key, t.Name, t.Description, t.Colour, now, user).Scan(&id)
	return id, err
}

func (s *Store) UpdateDSType(ctx context.Context, tx pgx.Tx, user string, now int64, t model.DSType) error {
	_, err := tx.Exec(ctx, `UPDATE ds_types SET description = $3, colour = $4, last_modified_at = $5, last_modified_by = $6
		WHERE tenant = $1 AND id = $2`, s.tenant, t.ID, t.Description, t.Colour, now, user)
	return err
}

func (s *Store) DeleteDSType(ctx context.Context, tx pgx.Tx, id int64) error {
	var used bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM distribution_sets WHERE type_id = $1)`, id).Scan(&used); err != nil {
		return err
	}
	if used {
		_, err := tx.Exec(ctx, `UPDATE ds_types SET deleted = TRUE WHERE tenant = $1 AND id = $2`, s.tenant, id)
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM ds_types WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return err
}

// DSTypeModuleTypes lists the module types a set type makes mandatory (or
// allows, with mandatory false).
func (s *Store) DSTypeModuleTypes(ctx context.Context, q Q, dsTypeID int64, mandatory bool) ([]model.SMType, error) {
	rows, err := q.Query(ctx, "SELECT "+smTypeCols+` FROM sm_types y
		JOIN ds_type_sm_types l ON l.sm_type_id = y.id
		WHERE l.ds_type_id = $1 AND l.mandatory = $2 ORDER BY y.id`, dsTypeID, mandatory)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.SMType{}
	for rows.Next() {
		t, err := scanSMType(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) SetDSTypeModuleType(ctx context.Context, tx pgx.Tx, dsTypeID, smTypeID int64, mandatory bool) error {
	_, err := tx.Exec(ctx, `INSERT INTO ds_type_sm_types (ds_type_id, sm_type_id, mandatory) VALUES ($1, $2, $3)
		ON CONFLICT (ds_type_id, sm_type_id) DO UPDATE SET mandatory = EXCLUDED.mandatory`, dsTypeID, smTypeID, mandatory)
	return err
}

func (s *Store) RemoveDSTypeModuleType(ctx context.Context, tx pgx.Tx, dsTypeID, smTypeID int64, mandatory bool) (bool, error) {
	tag, err := tx.Exec(ctx, `DELETE FROM ds_type_sm_types WHERE ds_type_id = $1 AND sm_type_id = $2 AND mandatory = $3`,
		dsTypeID, smTypeID, mandatory)
	return tag.RowsAffected() > 0, err
}

// ------------------------------------------------------------- target types

const targetTypeCols = "y.id, y.type_key, y.name, y.description, y.colour, " +
	"y.created_at, y.created_by, y.last_modified_at, y.last_modified_by"

func scanTargetType(r pgx.Row) (model.TargetType, error) {
	var t model.TargetType
	err := r.Scan(&t.ID, &t.Key, &t.Name, &t.Description, &t.Colour,
		&t.CreatedAt, &t.CreatedBy, &t.LastModifiedAt, &t.LastModifiedBy)
	return t, err
}

func (s *Store) TargetTypes(ctx context.Context, page httpx.Page) ([]model.TargetType, int64, error) {
	a := &Args{}
	out := []model.TargetType{}
	total, err := list(ctx, s.pool, listSpec{
		Select: targetTypeCols, From: "target_types y",
		Where:  []string{"y.tenant = " + a.Bind(s.tenant)},
		Fields: targetTypeFields, DefaultSort: "y.id ASC",
	}, a, page, func(r pgx.Rows) error {
		t, err := scanTargetType(r)
		out = append(out, t)
		return err
	})
	return out, total, err
}

func (s *Store) TargetType(ctx context.Context, q Q, id int64) (model.TargetType, error) {
	t, err := scanTargetType(q.QueryRow(ctx,
		"SELECT "+targetTypeCols+" FROM target_types y WHERE y.tenant = $1 AND y.id = $2", s.tenant, id))
	return t, notFound(err, "TargetType", id)
}

func (s *Store) CreateTargetType(ctx context.Context, tx pgx.Tx, user string, now int64, t model.TargetType) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO target_types (tenant, type_key, name, description, colour, `+auditCols+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7) RETURNING id`,
		s.tenant, t.Key, t.Name, t.Description, t.Colour, now, user).Scan(&id)
	return id, err
}

func (s *Store) UpdateTargetType(ctx context.Context, tx pgx.Tx, user string, now int64, t model.TargetType) error {
	_, err := tx.Exec(ctx, `UPDATE target_types SET name = $3, description = $4, colour = $5,
		last_modified_at = $6, last_modified_by = $7 WHERE tenant = $1 AND id = $2`,
		s.tenant, t.ID, t.Name, t.Description, t.Colour, now, user)
	return err
}

func (s *Store) DeleteTargetType(ctx context.Context, tx pgx.Tx, id int64) error {
	var used bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM targets WHERE target_type_id = $1)`, id).Scan(&used); err != nil {
		return err
	}
	if used {
		return httpx.Custom(409, "hawkbit.server.error.repo.entityReadOnly",
			"org.eclipse.hawkbit.repository.exception.EntityReadOnlyException",
			"the target type is still assigned to targets")
	}
	_, err := tx.Exec(ctx, `DELETE FROM target_types WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return err
}

func (s *Store) CompatibleDSTypes(ctx context.Context, q Q, targetTypeID int64) ([]model.DSType, error) {
	rows, err := q.Query(ctx, "SELECT "+dsTypeCols+` FROM ds_types y
		JOIN target_type_ds_types l ON l.ds_type_id = y.id WHERE l.target_type_id = $1 ORDER BY y.id`, targetTypeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.DSType{}
	for rows.Next() {
		t, err := scanDSType(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) AddCompatibleDSType(ctx context.Context, tx pgx.Tx, targetTypeID, dsTypeID int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO target_type_ds_types (target_type_id, ds_type_id) VALUES ($1, $2)
		ON CONFLICT DO NOTHING`, targetTypeID, dsTypeID)
	return err
}

func (s *Store) RemoveCompatibleDSType(ctx context.Context, tx pgx.Tx, targetTypeID, dsTypeID int64) (bool, error) {
	tag, err := tx.Exec(ctx, `DELETE FROM target_type_ds_types WHERE target_type_id = $1 AND ds_type_id = $2`,
		targetTypeID, dsTypeID)
	return tag.RowsAffected() > 0, err
}

// TargetTypeAccepts says whether a target of this type may receive a set of
// that type. A target without a type accepts everything, as in hawkBit.
func (s *Store) TargetTypeAccepts(ctx context.Context, q Q, targetTypeID *int64, dsTypeID int64) (bool, error) {
	if targetTypeID == nil {
		return true, nil
	}
	var ok bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM target_type_ds_types WHERE target_type_id = $1 AND ds_type_id = $2)`,
		*targetTypeID, dsTypeID).Scan(&ok)
	return ok, err
}
