// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Metadata: key/value pairs a user attaches to a module, a set or a target.
// The three tables have the same shape, so the same code serves them.

type MetaKind int

const (
	MetaSM MetaKind = iota
	MetaDS
	MetaTarget
)

type metaTable struct {
	table, owner string
	visible      bool // only module metadata has targetVisible
	entity       string
}

var metaTables = map[MetaKind]metaTable{
	MetaSM:     {"sm_metadata", "sm_id", true, "SoftwareModuleMetadata"},
	MetaDS:     {"ds_metadata", "ds_id", false, "DistributionSetMetadata"},
	MetaTarget: {"target_metadata", "target_id", false, "TargetMetadata"},
}

func (t metaTable) cols() string {
	if t.visible {
		return "md.meta_key, md.meta_value, md.target_visible"
	}
	return "md.meta_key, md.meta_value, FALSE"
}

func scanMeta(r pgx.Row) (model.Metadata, error) {
	var m model.Metadata
	err := r.Scan(&m.Key, &m.Value, &m.TargetVisible)
	return m, err
}

func (s *Store) Metadata(ctx context.Context, kind MetaKind, owner int64, page httpx.Page) ([]model.Metadata, int64, error) {
	t := metaTables[kind]
	a := &Args{}
	out := []model.Metadata{}
	total, err := list(ctx, s.pool, listSpec{
		Select: t.cols(), From: t.table + " md",
		Where:  []string{"md." + t.owner + " = " + a.Bind(owner)},
		Fields: metadataFields, DefaultSort: "md.meta_key ASC",
	}, a, page, func(r pgx.Rows) error {
		m, err := scanMeta(r)
		out = append(out, m)
		return err
	})
	return out, total, err
}

func (s *Store) MetadataOne(ctx context.Context, q Q, kind MetaKind, owner int64, key string) (model.Metadata, error) {
	t := metaTables[kind]
	m, err := scanMeta(q.QueryRow(ctx, "SELECT "+t.cols()+" FROM "+t.table+" md WHERE md."+t.owner+" = $1 AND md.meta_key = $2",
		owner, key))
	return m, notFound(err, t.entity, key)
}

// VisibleMetadata is the module metadata a device is shown in its
// deployment (targetVisible), for many modules at once.
func (s *Store) VisibleMetadata(ctx context.Context, q Q, smIDs []int64) (map[int64][]model.Metadata, error) {
	out := map[int64][]model.Metadata{}
	rows, err := q.Query(ctx, `SELECT sm_id, meta_key, meta_value FROM sm_metadata
		WHERE sm_id = ANY($1) AND target_visible ORDER BY meta_key`, smIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var m model.Metadata
		if err := rows.Scan(&id, &m.Key, &m.Value); err != nil {
			return nil, err
		}
		m.TargetVisible = true
		out[id] = append(out[id], m)
	}
	return out, rows.Err()
}

// CreateMetadata inserts; a key that exists already is a 409, as in hawkBit.
func (s *Store) CreateMetadata(ctx context.Context, tx pgx.Tx, kind MetaKind, owner int64, m model.Metadata) error {
	t := metaTables[kind]
	var err error
	if t.visible {
		_, err = tx.Exec(ctx, "INSERT INTO "+t.table+" ("+t.owner+", meta_key, meta_value, target_visible) VALUES ($1, $2, $3, $4)",
			owner, m.Key, m.Value, m.TargetVisible)
	} else {
		_, err = tx.Exec(ctx, "INSERT INTO "+t.table+" ("+t.owner+", meta_key, meta_value) VALUES ($1, $2, $3)",
			owner, m.Key, m.Value)
	}
	return err
}

func (s *Store) UpdateMetadata(ctx context.Context, tx pgx.Tx, kind MetaKind, owner int64, m model.Metadata) error {
	t := metaTables[kind]
	var err error
	var n int64
	if t.visible {
		tag, e := tx.Exec(ctx, "UPDATE "+t.table+" SET meta_value = $3, target_visible = $4 WHERE "+t.owner+" = $1 AND meta_key = $2",
			owner, m.Key, m.Value, m.TargetVisible)
		err, n = e, tag.RowsAffected()
	} else {
		tag, e := tx.Exec(ctx, "UPDATE "+t.table+" SET meta_value = $3 WHERE "+t.owner+" = $1 AND meta_key = $2",
			owner, m.Key, m.Value)
		err, n = e, tag.RowsAffected()
	}
	if err == nil && n == 0 {
		return httpx.NotFound(t.entity, m.Key)
	}
	return err
}

func (s *Store) DeleteMetadata(ctx context.Context, tx pgx.Tx, kind MetaKind, owner int64, key string) error {
	t := metaTables[kind]
	tag, err := tx.Exec(ctx, "DELETE FROM "+t.table+" WHERE "+t.owner+" = $1 AND meta_key = $2", owner, key)
	if err == nil && tag.RowsAffected() == 0 {
		return httpx.NotFound(t.entity, key)
	}
	return err
}
