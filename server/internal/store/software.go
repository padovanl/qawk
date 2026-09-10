package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Software modules and their artifacts.

const smFrom = "software_modules m JOIN sm_types y ON y.id = m.type_id"

// A module is complete when it has at least the artifacts its type demands.
const smCols = "m.id, m.type_id, y.type_key, y.name, m.name, m.version, m.description, m.vendor, " +
	"m.encrypted, m.locked, m.deleted, " +
	"(SELECT count(*) FROM artifacts ar WHERE ar.sm_id = m.id) >= y.min_artifacts, " +
	"m.created_at, m.created_by, m.last_modified_at, m.last_modified_by"

func scanSM(r pgx.Row) (model.SoftwareModule, error) {
	var m model.SoftwareModule
	err := r.Scan(&m.ID, &m.TypeID, &m.TypeKey, &m.TypeName, &m.Name, &m.Version, &m.Description, &m.Vendor,
		&m.Encrypted, &m.Locked, &m.Deleted, &m.Complete,
		&m.CreatedAt, &m.CreatedBy, &m.LastModifiedAt, &m.LastModifiedBy)
	return m, err
}

func (s *Store) SoftwareModules(ctx context.Context, page httpx.Page) ([]model.SoftwareModule, int64, error) {
	a := &Args{}
	out := []model.SoftwareModule{}
	total, err := list(ctx, s.pool, listSpec{
		Select: smCols, From: smFrom,
		Where:  []string{"m.tenant = " + a.Bind(s.tenant), "NOT m.deleted"},
		Fields: smFields, DefaultSort: "m.id ASC",
	}, a, page, func(r pgx.Rows) error {
		m, err := scanSM(r)
		out = append(out, m)
		return err
	})
	return out, total, err
}

// SoftwareModule returns a module, deleted or not: a deleted module is still
// what old actions installed, and the API says "deleted": true for it.
func (s *Store) SoftwareModule(ctx context.Context, q Q, id int64) (model.SoftwareModule, error) {
	m, err := scanSM(q.QueryRow(ctx, "SELECT "+smCols+" FROM "+smFrom+" WHERE m.tenant = $1 AND m.id = $2", s.tenant, id))
	return m, notFound(err, "SoftwareModule", id)
}

func (s *Store) CreateSM(ctx context.Context, tx pgx.Tx, user string, now int64, m model.SoftwareModule) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO software_modules (tenant, type_id, name, version, description, vendor, encrypted, `+auditCols+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $9) RETURNING id`,
		s.tenant, m.TypeID, m.Name, m.Version, m.Description, m.Vendor, m.Encrypted, now, user).Scan(&id)
	return id, err
}

func (s *Store) UpdateSM(ctx context.Context, tx pgx.Tx, user string, now int64, m model.SoftwareModule) error {
	_, err := tx.Exec(ctx, `UPDATE software_modules SET description = $3, vendor = $4, locked = $5,
		last_modified_at = $6, last_modified_by = $7 WHERE tenant = $1 AND id = $2`,
		s.tenant, m.ID, m.Description, m.Vendor, m.Locked, now, user)
	return err
}

// DeleteSM removes a module nobody refers to, and only hides one that a set
// still contains. It returns the hashes of the artifacts it dropped, so the
// caller can remove bytes no other artifact shares.
func (s *Store) DeleteSM(ctx context.Context, tx pgx.Tx, user string, now int64, id int64) ([]string, error) {
	var used bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM ds_modules WHERE sm_id = $1)`, id).Scan(&used); err != nil {
		return nil, err
	}
	if used {
		_, err := tx.Exec(ctx, `UPDATE software_modules SET deleted = TRUE, last_modified_at = $3, last_modified_by = $4
			WHERE tenant = $1 AND id = $2`, s.tenant, id, now, user)
		return nil, err
	}
	rows, err := tx.Query(ctx, `DELETE FROM artifacts WHERE sm_id = $1 RETURNING sha256`, id)
	if err != nil {
		return nil, err
	}
	var hashes []string
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			rows.Close()
			return nil, err
		}
		hashes = append(hashes, h)
	}
	rows.Close()
	_, err = tx.Exec(ctx, `DELETE FROM software_modules WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return hashes, err
}

// ModulesOf returns the modules of each set, in one query for all of them.
func (s *Store) ModulesOf(ctx context.Context, q Q, dsIDs []int64) (map[int64][]model.SoftwareModule, error) {
	out := map[int64][]model.SoftwareModule{}
	if len(dsIDs) == 0 {
		return out, nil
	}
	rows, err := q.Query(ctx, "SELECT dm.ds_id, "+smCols+" FROM ds_modules dm JOIN "+smFrom+
		" ON m.id = dm.sm_id WHERE dm.ds_id = ANY($1) ORDER BY m.id", dsIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var ds int64
		var m model.SoftwareModule
		if err := rows.Scan(&ds, &m.ID, &m.TypeID, &m.TypeKey, &m.TypeName, &m.Name, &m.Version, &m.Description,
			&m.Vendor, &m.Encrypted, &m.Locked, &m.Deleted, &m.Complete,
			&m.CreatedAt, &m.CreatedBy, &m.LastModifiedAt, &m.LastModifiedBy); err != nil {
			return nil, err
		}
		out[ds] = append(out[ds], m)
	}
	return out, rows.Err()
}

// InUseByLockedSet says whether the module belongs to a locked set: then its
// artifacts can no longer change, or a device could install something other
// than what was assigned.
func (s *Store) InUseByLockedSet(ctx context.Context, q Q, smID int64) (bool, error) {
	var locked bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM ds_modules dm JOIN distribution_sets d ON d.id = dm.ds_id
		WHERE dm.sm_id = $1 AND d.locked)`, smID).Scan(&locked)
	return locked, err
}

// ------------------------------------------------------------------ artifacts

const artCols = "ar.id, ar.sm_id, ar.filename, ar.sha1, ar.md5, ar.sha256, ar.size, " +
	"ar.created_at, ar.created_by, ar.last_modified_at, ar.last_modified_by"

func scanArtifact(r pgx.Row) (model.Artifact, error) {
	var a model.Artifact
	err := r.Scan(&a.ID, &a.SMID, &a.Filename, &a.SHA1, &a.MD5, &a.SHA256, &a.Size,
		&a.CreatedAt, &a.CreatedBy, &a.LastModifiedAt, &a.LastModifiedBy)
	return a, err
}

func (s *Store) Artifacts(ctx context.Context, q Q, smID int64) ([]model.Artifact, error) {
	rows, err := q.Query(ctx, "SELECT "+artCols+" FROM artifacts ar WHERE ar.sm_id = $1 ORDER BY ar.id", smID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Artifact{}
	for rows.Next() {
		a, err := scanArtifact(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) Artifact(ctx context.Context, q Q, smID, id int64) (model.Artifact, error) {
	a, err := scanArtifact(q.QueryRow(ctx, "SELECT "+artCols+" FROM artifacts ar WHERE ar.sm_id = $1 AND ar.id = $2", smID, id))
	return a, notFound(err, "Artifact", id)
}

func (s *Store) ArtifactByName(ctx context.Context, q Q, smID int64, filename string) (model.Artifact, error) {
	a, err := scanArtifact(q.QueryRow(ctx,
		"SELECT "+artCols+" FROM artifacts ar WHERE ar.sm_id = $1 AND ar.filename = $2", smID, filename))
	return a, notFound(err, "Artifact", filename)
}

func (s *Store) CreateArtifact(ctx context.Context, tx pgx.Tx, user string, now int64, a model.Artifact) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO artifacts (sm_id, filename, sha1, md5, sha256, size, `+auditCols+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7, $8) RETURNING id`,
		a.SMID, a.Filename, a.SHA1, a.MD5, a.SHA256, a.Size, now, user).Scan(&id)
	return id, err
}

func (s *Store) DeleteArtifact(ctx context.Context, tx pgx.Tx, smID, id int64) (string, error) {
	var sha string
	err := tx.QueryRow(ctx, `DELETE FROM artifacts WHERE sm_id = $1 AND id = $2 RETURNING sha256`, smID, id).Scan(&sha)
	return sha, notFound(err, "Artifact", id)
}

// HashInUse says whether any artifact still points at these bytes: two
// modules uploading the same file share one copy in the store.
func (s *Store) HashInUse(ctx context.Context, q Q, sha256 string) (bool, error) {
	var used bool
	err := q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM artifacts WHERE sha256 = $1)`, sha256).Scan(&used)
	return used, err
}
