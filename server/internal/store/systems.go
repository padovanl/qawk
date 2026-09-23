// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"qawk/internal/model"
)

// Systems (a Qawk addition, after Mender Orchestrator).

// ------------------------------------------------------------ system types

const sysTypeCols = `y.id, y.name, y.description, y.key_field, y.group_field, y.created_at, y.created_by,
	y.last_modified_at, y.last_modified_by`

func (s *Store) systemComponents(ctx context.Context, q Q, id int64) ([]model.SystemComponent, error) {
	rows, err := q.Query(ctx, `SELECT component_type, match_query FROM system_components
		WHERE system_type_id = $1 ORDER BY component_type`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.SystemComponent{}
	for rows.Next() {
		var c model.SystemComponent
		if err := rows.Scan(&c.ComponentType, &c.Match); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) SystemTypes(ctx context.Context) ([]model.SystemType, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+sysTypeCols+" FROM system_types y WHERE y.tenant = $1 ORDER BY y.name", s.tenant)
	if err != nil {
		return nil, err
	}
	var out []model.SystemType
	for rows.Next() {
		var t model.SystemType
		if err := rows.Scan(&t.ID, &t.Name, &t.Description, &t.KeyField, &t.GroupField, &t.CreatedAt, &t.CreatedBy,
			&t.LastModifiedAt, &t.LastModifiedBy); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, t)
	}
	rows.Close()
	for i := range out {
		if out[i].Components, err = s.systemComponents(ctx, s.pool, out[i].ID); err != nil {
			return nil, err
		}
	}
	if out == nil {
		out = []model.SystemType{}
	}
	return out, rows.Err()
}

func (s *Store) SystemType(ctx context.Context, q Q, id int64) (model.SystemType, error) {
	var t model.SystemType
	err := q.QueryRow(ctx, "SELECT "+sysTypeCols+" FROM system_types y WHERE y.tenant = $1 AND y.id = $2", s.tenant, id).
		Scan(&t.ID, &t.Name, &t.Description, &t.KeyField, &t.GroupField, &t.CreatedAt, &t.CreatedBy,
			&t.LastModifiedAt, &t.LastModifiedBy)
	if err != nil {
		return t, notFound(err, "SystemType", id)
	}
	t.Components, err = s.systemComponents(ctx, q, id)
	return t, err
}

// SystemTypeByName finds a type by its name.
func (s *Store) SystemTypeByName(ctx context.Context, q Q, name string) (model.SystemType, error) {
	var id int64
	if err := q.QueryRow(ctx, `SELECT id FROM system_types WHERE tenant = $1 AND name = $2`, s.tenant, name).Scan(&id); err != nil {
		return model.SystemType{}, notFound(err, "SystemType", name)
	}
	return s.SystemType(ctx, q, id)
}

func (s *Store) SaveSystemType(ctx context.Context, tx pgx.Tx, user string, now int64, t model.SystemType) (int64, error) {
	id := t.ID
	if id == 0 {
		if err := tx.QueryRow(ctx, `INSERT INTO system_types (tenant, name, description, key_field, group_field,
			created_at, created_by, last_modified_at, last_modified_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $6, $7) RETURNING id`,
			s.tenant, t.Name, t.Description, t.KeyField, t.GroupField, now, user).Scan(&id); err != nil {
			return 0, err
		}
	} else if _, err := tx.Exec(ctx, `UPDATE system_types SET name = $3, description = $4, key_field = $5,
		group_field = $6, last_modified_at = $7, last_modified_by = $8 WHERE tenant = $1 AND id = $2`,
		s.tenant, id, t.Name, t.Description, t.KeyField, t.GroupField, now, user); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM system_components WHERE system_type_id = $1`, id); err != nil {
		return 0, err
	}
	for _, c := range t.Components {
		if _, err := tx.Exec(ctx, `INSERT INTO system_components (system_type_id, component_type, match_query)
			VALUES ($1, $2, $3)`, id, c.ComponentType, c.Match); err != nil {
			return 0, err
		}
	}
	return id, nil
}

func (s *Store) DeleteSystemType(ctx context.Context, tx pgx.Tx, id int64) error {
	_, err := tx.Exec(ctx, `DELETE FROM system_types WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return err
}

// KeyValues reads, for these targets, the value of an attribute.<key> or
// metadata.<key> field: which system each says it is in.
func (s *Store) KeyValues(ctx context.Context, ids []int64, field string) (map[int64]string, error) {
	out := map[int64]string{}
	if len(ids) == 0 {
		return out, nil
	}
	var sql string
	switch {
	case strings.HasPrefix(field, "attribute."):
		sql = `SELECT target_id, attr_value FROM target_attributes WHERE target_id = ANY($1) AND attr_key = $2`
	case strings.HasPrefix(field, "metadata."):
		sql = `SELECT target_id, meta_value FROM target_metadata WHERE target_id = ANY($1) AND meta_key = $2`
	default:
		return nil, fmt.Errorf("a system key is attribute.<key> or metadata.<key>, not %q", field)
	}
	rows, err := s.pool.Query(ctx, sql, ids, field[strings.IndexByte(field, '.')+1:])
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var v string
		if err := rows.Scan(&id, &v); err != nil {
			return nil, err
		}
		out[id] = v
	}
	return out, rows.Err()
}

// SetSystemMembers replaces the recorded members of a system type: target,
// system, component. The fleets leave these to system deployments.
func (s *Store) SetSystemMembers(ctx context.Context, typeID int64, ids []int64, keys, comps []string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM system_members WHERE system_type_id = $1`, typeID); err != nil {
			return err
		}
		if len(ids) == 0 {
			return nil
		}
		_, err := tx.Exec(ctx, `INSERT INTO system_members (target_id, system_type_id, system_key, component_type)
			SELECT u.id, $1, u.k, u.c FROM unnest($2::bigint[], $3::text[], $4::text[]) AS u(id, k, c)
			ON CONFLICT DO NOTHING`, typeID, ids, keys, comps)
		return err
	})
}

// TargetFleets says which fleet each of these targets is in (absent: none).
func (s *Store) TargetFleets(ctx context.Context, ids []int64) (map[int64]int64, error) {
	out := map[int64]int64{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `SELECT id, fleet_id FROM targets WHERE id = ANY($1) AND fleet_id IS NOT NULL`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, f int64
		if err := rows.Scan(&id, &f); err != nil {
			return nil, err
		}
		out[id] = f
	}
	return out, rows.Err()
}

// FleetLabel is a fleet's name and colour.
type FleetLabel struct {
	Name   string
	Colour *string
}

// FleetLabels gives every fleet's name and colour, by id.
func (s *Store) FleetLabels(ctx context.Context) (map[int64]FleetLabel, error) {
	rows, err := s.pool.Query(ctx, `SELECT id, name, colour FROM fleets WHERE tenant = $1`, s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]FleetLabel{}
	for rows.Next() {
		var id int64
		var l FleetLabel
		if err := rows.Scan(&id, &l.Name, &l.Colour); err != nil {
			return nil, err
		}
		out[id] = l
	}
	return out, rows.Err()
}

// ------------------------------------------------------------ manifests

const manifestCols = `m.id, m.name, m.description, m.system_type_id, (SELECT y.name FROM system_types y WHERE y.id = m.system_type_id),
	m.created_at, m.created_by, m.last_modified_at, m.last_modified_by`

func (s *Store) manifestComponents(ctx context.Context, q Q, id int64) ([]model.ManifestComponent, error) {
	rows, err := q.Query(ctx, `SELECT c.component_type, c.ds_id,
		coalesce((SELECT x.name || ':' || x.version FROM distribution_sets x WHERE x.id = c.ds_id), ''), c.update_order
		FROM manifest_components c WHERE c.manifest_id = $1 ORDER BY c.update_order, c.component_type`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.ManifestComponent{}
	for rows.Next() {
		var c model.ManifestComponent
		if err := rows.Scan(&c.ComponentType, &c.DSID, &c.DSLabel, &c.Order); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func scanManifest(r pgx.Row) (model.Manifest, error) {
	var m model.Manifest
	err := r.Scan(&m.ID, &m.Name, &m.Description, &m.SystemTypeID, &m.SystemType, &m.CreatedAt, &m.CreatedBy,
		&m.LastModifiedAt, &m.LastModifiedBy)
	return m, err
}

func (s *Store) Manifests(ctx context.Context) ([]model.Manifest, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+manifestCols+" FROM manifests m WHERE m.tenant = $1 ORDER BY m.id DESC", s.tenant)
	if err != nil {
		return nil, err
	}
	var out []model.Manifest
	for rows.Next() {
		m, err := scanManifest(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, m)
	}
	rows.Close()
	for i := range out {
		if out[i].Components, err = s.manifestComponents(ctx, s.pool, out[i].ID); err != nil {
			return nil, err
		}
	}
	if out == nil {
		out = []model.Manifest{}
	}
	return out, nil
}

func (s *Store) Manifest(ctx context.Context, q Q, id int64) (model.Manifest, error) {
	m, err := scanManifest(q.QueryRow(ctx, "SELECT "+manifestCols+" FROM manifests m WHERE m.tenant = $1 AND m.id = $2", s.tenant, id))
	if err != nil {
		return m, notFound(err, "Manifest", id)
	}
	m.Components, err = s.manifestComponents(ctx, q, id)
	return m, err
}

// ManifestByName finds a manifest by its name.
func (s *Store) ManifestByName(ctx context.Context, q Q, name string) (model.Manifest, error) {
	var id int64
	if err := q.QueryRow(ctx, `SELECT id FROM manifests WHERE tenant = $1 AND name = $2`, s.tenant, name).Scan(&id); err != nil {
		return model.Manifest{}, notFound(err, "Manifest", name)
	}
	return s.Manifest(ctx, q, id)
}

func (s *Store) SaveManifest(ctx context.Context, tx pgx.Tx, user string, now int64, m model.Manifest) (int64, error) {
	id := m.ID
	if id == 0 {
		if err := tx.QueryRow(ctx, `INSERT INTO manifests (tenant, name, description, system_type_id,
			created_at, created_by, last_modified_at, last_modified_by) VALUES ($1, $2, $3, $4, $5, $6, $5, $6) RETURNING id`,
			s.tenant, m.Name, m.Description, m.SystemTypeID, now, user).Scan(&id); err != nil {
			return 0, err
		}
	} else if _, err := tx.Exec(ctx, `UPDATE manifests SET name = $3, description = $4, system_type_id = $5,
		last_modified_at = $6, last_modified_by = $7 WHERE tenant = $1 AND id = $2`,
		s.tenant, id, m.Name, m.Description, m.SystemTypeID, now, user); err != nil {
		return 0, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM manifest_components WHERE manifest_id = $1`, id); err != nil {
		return 0, err
	}
	for _, c := range m.Components {
		if _, err := tx.Exec(ctx, `INSERT INTO manifest_components (manifest_id, component_type, ds_id, update_order)
			VALUES ($1, $2, $3, $4)`, id, c.ComponentType, c.DSID, c.Order); err != nil {
			return 0, err
		}
	}
	return id, nil
}

func (s *Store) DeleteManifest(ctx context.Context, tx pgx.Tx, id int64) error {
	_, err := tx.Exec(ctx, `DELETE FROM manifests WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return err
}

// SetByLabel finds a distribution set by "name:version", or by name alone
// (the newest version).
func (s *Store) SetByLabel(ctx context.Context, label string) (int64, error) {
	name, version, hasVersion := strings.Cut(label, ":")
	var id int64
	var err error
	if hasVersion {
		err = s.pool.QueryRow(ctx, `SELECT id FROM distribution_sets WHERE tenant = $1 AND name = $2 AND version = $3
			AND NOT deleted`, s.tenant, name, version).Scan(&id)
	} else {
		err = s.pool.QueryRow(ctx, `SELECT id FROM distribution_sets WHERE tenant = $1 AND name = $2 AND NOT deleted
			ORDER BY id DESC LIMIT 1`, s.tenant, name).Scan(&id)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, notFound(err, "DistributionSet", label)
	}
	return id, err
}

// ------------------------------------------------------------ deployments

const sdCols = `d.id, d.name, d.manifest_id, (SELECT m.name FROM manifests m WHERE m.id = d.manifest_id), d.systems,
	d.fleet_id, (SELECT f.name FROM fleets f WHERE f.id = d.fleet_id), d.groups,
	d.max_parallel, d.max_failed, d.action_type, d.status, d.reason, d.started_by, d.started_at, d.finished_at,
	d.created_at, d.created_by, d.last_modified_at, d.last_modified_by, d.by_group`

func scanSD(r pgx.Row) (model.SystemDeployment, error) {
	var d model.SystemDeployment
	err := r.Scan(&d.ID, &d.Name, &d.ManifestID, &d.Manifest, &d.Systems, &d.FleetID, &d.Fleet, &d.Groups,
		&d.MaxParallel, &d.MaxFailed, &d.ActionType,
		&d.Status, &d.Reason, &d.StartedBy, &d.StartedAt, &d.FinishedAt, &d.CreatedAt, &d.CreatedBy,
		&d.LastModifiedAt, &d.LastModifiedBy, &d.ByGroup)
	return d, err
}

// SystemDeployments lists deployments, newest first; statuses nil: all.
func (s *Store) SystemDeployments(ctx context.Context, statuses []string) ([]model.SystemDeployment, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+sdCols+" FROM system_deployments d WHERE d.tenant = $1 "+
		"AND ($2::text[] IS NULL OR d.status = ANY($2)) ORDER BY d.id DESC", s.tenant, statuses)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.SystemDeployment{}
	for rows.Next() {
		d, err := scanSD(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// EndedWithRollbacks lists the deployments that are no longer running but
// have a system still going back: one rolled back by hand after the end.
func (s *Store) EndedWithRollbacks(ctx context.Context) ([]model.SystemDeployment, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+sdCols+" FROM system_deployments d WHERE d.tenant = $1 "+
		"AND d.status <> 'running' AND EXISTS (SELECT 1 FROM system_runs r WHERE r.deployment_id = d.id "+
		"AND r.status = 'rolling_back') ORDER BY d.id", s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.SystemDeployment{}
	for rows.Next() {
		d, err := scanSD(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (s *Store) SystemDeployment(ctx context.Context, q Q, id int64) (model.SystemDeployment, error) {
	d, err := scanSD(q.QueryRow(ctx, "SELECT "+sdCols+" FROM system_deployments d WHERE d.tenant = $1 AND d.id = $2", s.tenant, id))
	return d, notFound(err, "SystemDeployment", id)
}

func (s *Store) CreateSystemDeployment(ctx context.Context, tx pgx.Tx, user string, now int64, d model.SystemDeployment) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `INSERT INTO system_deployments (tenant, name, manifest_id, systems, fleet_id, groups,
		max_parallel, max_failed, action_type, created_at, created_by, last_modified_at, last_modified_by, by_group)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, $11, $12) RETURNING id`,
		s.tenant, d.Name, d.ManifestID, d.Systems, d.FleetID, d.Groups, d.MaxParallel, d.MaxFailed, d.ActionType,
		now, user, d.ByGroup).Scan(&id)
	return id, err
}

func (s *Store) SetSystemDeploymentState(ctx context.Context, q Q, d model.SystemDeployment) error {
	_, err := q.Exec(ctx, `UPDATE system_deployments SET status = $3, reason = $4, started_by = $5, started_at = $6,
		finished_at = $7 WHERE tenant = $1 AND id = $2`,
		s.tenant, d.ID, d.Status, d.Reason, d.StartedBy, d.StartedAt, d.FinishedAt)
	return err
}

func (s *Store) DeleteSystemDeployment(ctx context.Context, tx pgx.Tx, id int64) error {
	_, err := tx.Exec(ctx, `DELETE FROM system_deployments WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return err
}

// ------------------------------------------------------------ runs

const runCols = `r.id, r.deployment_id, r.system_key, r.status, r.current_order, r.reason, r.started_at, r.stage_at,
	r.rollback_at, r.finished_at, r.group_key, r.group_rank`

// runOrder is the order the engine takes the runs in: the centres as the
// deployment decided them, then by name, and inside a centre by system.
const runOrder = ` ORDER BY r.group_rank, r.group_key, r.system_key`

func scanRun(r pgx.Row) (model.SystemRun, error) {
	var n model.SystemRun
	err := r.Scan(&n.ID, &n.DeploymentID, &n.SystemKey, &n.Status, &n.CurrentOrder, &n.Reason, &n.StartedAt,
		&n.StageAt, &n.RollbackAt, &n.FinishedAt, &n.Group, &n.GroupRank)
	return n, err
}

func (s *Store) Runs(ctx context.Context, q Q, deployment int64) ([]model.SystemRun, error) {
	rows, err := q.Query(ctx, "SELECT "+runCols+" FROM system_runs r WHERE r.deployment_id = $1"+runOrder, deployment)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.SystemRun{}
	for rows.Next() {
		r, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

func (s *Store) Run(ctx context.Context, q Q, deployment, id int64) (model.SystemRun, error) {
	r, err := scanRun(q.QueryRow(ctx, "SELECT "+runCols+" FROM system_runs r WHERE r.deployment_id = $1 AND r.id = $2",
		deployment, id))
	return r, notFound(err, "SystemRun", id)
}

// CreateRuns records the systems a deployment takes, each with its centre and
// that centre's place in the order. A system the deployment already has is
// left as it is -- it may have run, failed or been skipped already -- so the
// orchestrator can ask again for a channel whose centres change under it.
// It answers how many systems it had never seen before.
func (s *Store) CreateRuns(ctx context.Context, q Q, deployment int64, keys, groups []string, ranks []int32) (int64, error) {
	tag, err := q.Exec(ctx, `INSERT INTO system_runs (deployment_id, system_key, group_key, group_rank)
		SELECT $1, u.k, u.g, u.r FROM unnest($2::text[], $3::text[], $4::int[]) AS u(k, g, r)
		ON CONFLICT (deployment_id, system_key) DO NOTHING`, deployment, keys, groups, ranks)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// DropPendingRuns gives up the systems a deployment has not started that are
// no longer its own -- a centre moved out of the channel. It answers how many.
func (s *Store) DropPendingRuns(ctx context.Context, q Q, deployment int64, keep []string, why string) (int64, error) {
	tag, err := q.Exec(ctx, `UPDATE system_runs SET status = 'skipped', reason = $3
		WHERE deployment_id = $1 AND status = 'pending' AND NOT (system_key = ANY($2::text[]))`,
		deployment, keep, why)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// ReRank moves the runs a deployment has not started into a new centre order.
func (s *Store) ReRank(ctx context.Context, q Q, deployment int64, groups []string, ranks []int32) error {
	_, err := q.Exec(ctx, `UPDATE system_runs r SET group_rank = u.r
		FROM unnest($2::text[], $3::int[]) AS u(g, r)
		WHERE r.deployment_id = $1 AND r.group_key = u.g AND r.group_rank <> u.r`, deployment, groups, ranks)
	return err
}

func (s *Store) SetRunState(ctx context.Context, q Q, r model.SystemRun) error {
	_, err := q.Exec(ctx, `UPDATE system_runs SET status = $2, current_order = $3, reason = $4, started_at = $5,
		stage_at = $6, rollback_at = $7, finished_at = $8 WHERE id = $1`,
		r.ID, r.Status, r.CurrentOrder, r.Reason, r.StartedAt, r.StageAt, r.RollbackAt, r.FinishedAt)
	return err
}

// ResetRun puts one run back to pending, with nothing remembered of the
// attempt before it: its devices and what each was running are recorded
// again when it starts, so a rollback after this one goes back to where the
// system is now, not to where it was before the first try.
func (s *Store) ResetRun(ctx context.Context, run int64, why string) error {
	return pgx.BeginFunc(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `DELETE FROM system_run_targets WHERE run_id = $1`, run); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `UPDATE system_runs SET status = 'pending', reason = $2, current_order = NULL,
			started_at = NULL, stage_at = NULL, rollback_at = NULL, finished_at = NULL WHERE id = $1`, run, why)
		return err
	})
}

// SkipPendingRuns marks the runs not yet started as skipped.
func (s *Store) SkipPendingRuns(ctx context.Context, q Q, deployment int64, why string) error {
	_, err := q.Exec(ctx, `UPDATE system_runs SET status = 'skipped', reason = $2 WHERE deployment_id = $1 AND status = 'pending'`,
		deployment, why)
	return err
}

// SnapshotRun records a component's devices in a run, and what each runs now.
func (s *Store) SnapshotRun(ctx context.Context, run int64, ids []int64, component string, order int, ds int64) error {
	_, err := s.pool.Exec(ctx, `
		INSERT INTO system_run_targets (run_id, target_id, component_type, update_order, ds_id, previous_ds_id, already)
		SELECT $1, t.id, $2, $3, $4, t.installed_ds_id, t.installed_ds_id IS NOT DISTINCT FROM $4::bigint
		FROM targets t WHERE t.tenant = $5 AND t.id = ANY($6)
		ON CONFLICT DO NOTHING`, run, component, order, ds, s.tenant, ids)
	return err
}

// NextOrder is the lowest order of a run above after (-1: the first).
func (s *Store) NextOrder(ctx context.Context, run int64, after int) (int, bool, error) {
	var o *int
	err := s.pool.QueryRow(ctx, `SELECT min(update_order) FROM system_run_targets WHERE run_id = $1 AND update_order > $2`,
		run, after).Scan(&o)
	if err != nil || o == nil {
		return 0, false, err
	}
	return *o, true, nil
}

func (s *Store) StageProgress(ctx context.Context, run int64, order int, since int64) (model.StageProgress, error) {
	var p model.StageProgress
	const ok = `(rt.already OR EXISTS (SELECT 1 FROM actions a WHERE a.target_id = rt.target_id AND a.ds_id = rt.ds_id
		AND a.status = 'finished' AND a.created_at >= $3))`
	err := s.pool.QueryRow(ctx, `
		SELECT count(*), count(*) FILTER (WHERE rt.already),
		       count(*) FILTER (WHERE `+ok+`),
		       count(*) FILTER (WHERE NOT `+ok+` AND EXISTS (SELECT 1 FROM actions a WHERE a.target_id = rt.target_id
		                        AND a.ds_id = rt.ds_id AND a.status = 'error' AND a.created_at >= $3)),
		       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM actions a WHERE a.target_id = rt.target_id
		                        AND a.ds_id = rt.ds_id AND a.active)),
		       count(*) FILTER (WHERE NOT rt.assigned AND NOT rt.already)
		FROM system_run_targets rt WHERE rt.run_id = $1 AND rt.update_order = $2`, run, order, since).
		Scan(&p.Targets, &p.Already, &p.Succeeded, &p.Failed, &p.Active, &p.Unassigned)
	return p, err
}

// StageUnassigned is the devices of an order not yet sent their set, by set.
func (s *Store) StageUnassigned(ctx context.Context, run int64, order int) (map[int64][]int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT target_id, ds_id FROM system_run_targets
		WHERE run_id = $1 AND update_order = $2 AND NOT assigned AND NOT already ORDER BY target_id`, run, order)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]int64{}
	for rows.Next() {
		var t, ds int64
		if err := rows.Scan(&t, &ds); err != nil {
			return nil, err
		}
		out[ds] = append(out[ds], t)
	}
	return out, rows.Err()
}

func (s *Store) MarkRunAssigned(ctx context.Context, run int64, ids []int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE system_run_targets SET assigned = true WHERE run_id = $1 AND target_id = ANY($2)`, run, ids)
	return err
}

// RunRollbackCandidates are a run's updated devices to put back, by the set each ran.
func (s *Store) RunRollbackCandidates(ctx context.Context, run int64) (map[int64][]int64, error) {
	rows, err := s.pool.Query(ctx, `SELECT target_id, previous_ds_id FROM system_run_targets
		WHERE run_id = $1 AND assigned AND NOT rollback_sent AND previous_ds_id IS NOT NULL
		  AND previous_ds_id <> ds_id ORDER BY target_id`, run)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]int64{}
	for rows.Next() {
		var t, prev int64
		if err := rows.Scan(&t, &prev); err != nil {
			return nil, err
		}
		out[prev] = append(out[prev], t)
	}
	return out, rows.Err()
}

func (s *Store) MarkRunRollbackSent(ctx context.Context, run int64, ids []int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE system_run_targets SET rollback_sent = true WHERE run_id = $1 AND target_id = ANY($2)`,
		run, ids)
	return err
}

// RunRollbackProgress counts a run's devices being put back since since.
func (s *Store) RunRollbackProgress(ctx context.Context, run, since int64) (model.RollbackProgress, error) {
	var p model.RollbackProgress
	err := s.pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE rt.rollback_sent),
		       count(*) FILTER (WHERE rt.rollback_sent AND t.installed_ds_id = rt.previous_ds_id),
		       count(*) FILTER (WHERE rt.rollback_sent AND t.installed_ds_id IS DISTINCT FROM rt.previous_ds_id
		                        AND EXISTS (SELECT 1 FROM actions a WHERE a.target_id = rt.target_id
		                        AND a.ds_id = rt.previous_ds_id AND a.status = 'error' AND a.created_at >= $2)),
		       count(*) FILTER (WHERE rt.rollback_sent AND EXISTS (SELECT 1 FROM actions a
		                        WHERE a.target_id = rt.target_id AND a.ds_id = rt.previous_ds_id AND a.active)),
		       count(*) FILTER (WHERE rt.assigned AND rt.previous_ds_id IS NULL)
		FROM system_run_targets rt JOIN targets t ON t.id = rt.target_id WHERE rt.run_id = $1`, run, since).
		Scan(&p.Sent, &p.Done, &p.Failed, &p.Active, &p.None)
	return p, err
}

// RunComponents is how each component of these runs is going, in one query.
func (s *Store) RunComponents(ctx context.Context, runs []int64) (map[int64][]model.RunComponent, error) {
	out := map[int64][]model.RunComponent{}
	if len(runs) == 0 {
		return out, nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT rt.run_id, rt.component_type, rt.update_order, count(*),
		       count(*) FILTER (WHERE t.installed_ds_id = rt.ds_id),
		       count(*) FILTER (WHERE rt.rollback_sent AND t.installed_ds_id = rt.previous_ds_id)
		FROM system_run_targets rt JOIN targets t ON t.id = rt.target_id
		WHERE rt.run_id = ANY($1)
		GROUP BY rt.run_id, rt.component_type, rt.update_order
		ORDER BY rt.run_id, rt.update_order, rt.component_type`, runs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var c model.RunComponent
		if err := rows.Scan(&id, &c.ComponentType, &c.Order, &c.Devices, &c.OnSet, &c.Back); err != nil {
			return nil, err
		}
		out[id] = append(out[id], c)
	}
	return out, rows.Err()
}

// ControllerIDsOf maps target ids to controller ids.
func (s *Store) ControllerIDsOf(ctx context.Context, ids []int64) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT controller_id FROM targets WHERE tenant = $1 AND id = ANY($2) ORDER BY id`,
		s.tenant, ids)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}
