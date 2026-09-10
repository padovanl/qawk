package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"qawk/internal/fiql"
	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Users, roles, API tokens and the audit log (a Qawk addition).

// ------------------------------------------------------------------ roles

const roleCols = `name, description, permissions, builtin, created_at, created_by, last_modified_at, last_modified_by`

func scanRole(r pgx.Row) (model.Role, error) {
	var x model.Role
	err := r.Scan(&x.Name, &x.Description, &x.Permissions, &x.Builtin,
		&x.CreatedAt, &x.CreatedBy, &x.LastModifiedAt, &x.LastModifiedBy)
	return x, err
}

// EnsureRoles writes the built-in roles as the code defines them, at every
// start: a release that gives "operator" a new permission reaches the servers
// already running.
func (s *Store) EnsureRoles(ctx context.Context, roles []model.Role) error {
	return s.Tx(ctx, "system", func(tx pgx.Tx, now int64) error {
		for _, x := range roles {
			if _, err := tx.Exec(ctx, `
				INSERT INTO roles (tenant, name, description, permissions, builtin,
				                   created_at, created_by, last_modified_at, last_modified_by)
				VALUES ($1, $2, $3, $4, true, $5, 'system', $5, 'system')
				ON CONFLICT (tenant, name) DO UPDATE
				SET description = EXCLUDED.description, permissions = EXCLUDED.permissions, builtin = true`,
				s.tenant, x.Name, x.Description, x.Permissions, now); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) Roles(ctx context.Context) ([]model.Role, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+roleCols+" FROM roles WHERE tenant = $1 ORDER BY builtin DESC, name", s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Role{}
	for rows.Next() {
		x, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, x)
	}
	return out, rows.Err()
}

func (s *Store) Role(ctx context.Context, q Q, name string) (model.Role, error) {
	x, err := scanRole(q.QueryRow(ctx, "SELECT "+roleCols+" FROM roles WHERE tenant = $1 AND name = $2", s.tenant, name))
	return x, notFound(err, "Role", name)
}

func (s *Store) CreateRole(ctx context.Context, tx pgx.Tx, user string, now int64, x model.Role) error {
	_, err := tx.Exec(ctx, `
		INSERT INTO roles (tenant, name, description, permissions, builtin,
		                   created_at, created_by, last_modified_at, last_modified_by)
		VALUES ($1, $2, $3, coalesce($4::text[], '{}'), false, $5, $6, $5, $6)`,
		s.tenant, x.Name, x.Description, x.Permissions, now, user)
	return err
}

func (s *Store) UpdateRole(ctx context.Context, tx pgx.Tx, user string, now int64, x model.Role) error {
	_, err := tx.Exec(ctx, `
		UPDATE roles SET description = $3, permissions = coalesce($4::text[], '{}'),
		       last_modified_at = $5, last_modified_by = $6
		WHERE tenant = $1 AND name = $2 AND NOT builtin`,
		s.tenant, x.Name, x.Description, x.Permissions, now, user)
	return err
}

// DeleteRole removes a role, and takes it away from whoever had it.
func (s *Store) DeleteRole(ctx context.Context, tx pgx.Tx, name string) error {
	if _, err := tx.Exec(ctx, `UPDATE users SET roles = array_remove(roles, $2) WHERE tenant = $1`, s.tenant, name); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM roles WHERE tenant = $1 AND name = $2 AND NOT builtin`, s.tenant, name)
	return err
}

// PermissionsOf is the union of the permissions of these roles.
func (s *Store) PermissionsOf(ctx context.Context, roles []string) ([]string, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT DISTINCT unnest(permissions) FROM roles WHERE tenant = $1 AND name = ANY($2)`, s.tenant, roles)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[string])
}

// ------------------------------------------------------------------ users

const userCols = `id, username, display_name, roles, enabled, last_login_at,
	created_at, created_by, last_modified_at, last_modified_by`

func scanUser(r pgx.Row, extra ...any) (model.User, error) {
	var u model.User
	dst := append([]any{&u.ID, &u.Username, &u.DisplayName, &u.Roles, &u.Enabled, &u.LastLoginAt,
		&u.CreatedAt, &u.CreatedBy, &u.LastModifiedAt, &u.LastModifiedBy}, extra...)
	return u, r.Scan(dst...)
}

func (s *Store) Users(ctx context.Context) ([]model.User, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+userCols+" FROM users WHERE tenant = $1 ORDER BY lower(username)", s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

func (s *Store) User(ctx context.Context, q Q, id int64) (model.User, error) {
	u, err := scanUser(q.QueryRow(ctx, "SELECT "+userCols+" FROM users WHERE tenant = $1 AND id = $2", s.tenant, id))
	return u, notFound(err, "User", id)
}

// UserCredentials finds a user by name, whatever the case, with the hash of
// the password.
func (s *Store) UserCredentials(ctx context.Context, username string) (model.User, string, error) {
	var hash string
	u, err := scanUser(s.pool.QueryRow(ctx, "SELECT "+userCols+", password_hash FROM users "+
		"WHERE tenant = $1 AND lower(username) = lower($2)", s.tenant, username), &hash)
	return u, hash, notFound(err, "User", username)
}

func (s *Store) CreateUser(ctx context.Context, tx pgx.Tx, user string, now int64, u model.User, hash string) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO users (tenant, username, display_name, password_hash, roles, enabled,
		                   created_at, created_by, last_modified_at, last_modified_by)
		VALUES ($1, $2, $3, $4, coalesce($5::text[], '{}'), $6, $7, $8, $7, $8) RETURNING id`,
		s.tenant, u.Username, u.DisplayName, hash, u.Roles, u.Enabled, now, user).Scan(&id)
	return id, err
}

func (s *Store) UpdateUser(ctx context.Context, tx pgx.Tx, user string, now int64, u model.User) error {
	_, err := tx.Exec(ctx, `
		UPDATE users SET display_name = $3, roles = coalesce($4::text[], '{}'), enabled = $5,
		       last_modified_at = $6, last_modified_by = $7
		WHERE tenant = $1 AND id = $2`,
		s.tenant, u.ID, u.DisplayName, u.Roles, u.Enabled, now, user)
	return err
}

func (s *Store) SetPassword(ctx context.Context, tx pgx.Tx, user string, now int64, id int64, hash string) error {
	_, err := tx.Exec(ctx, `UPDATE users SET password_hash = $3, last_modified_at = $4, last_modified_by = $5
		WHERE tenant = $1 AND id = $2`, s.tenant, id, hash, now, user)
	return err
}

func (s *Store) DeleteUser(ctx context.Context, tx pgx.Tx, id int64) error {
	_, err := tx.Exec(ctx, `DELETE FROM users WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return err
}

func (s *Store) TouchLogin(ctx context.Context, id, now int64) {
	_, _ = s.pool.Exec(ctx, `UPDATE users SET last_login_at = $2 WHERE id = $1`, id, now)
}

// ------------------------------------------------------------------ tokens

const tokenCols = `id, user_id, username, name, hint, created_at, expires_at, last_used_at`

func scanToken(r pgx.Row) (model.APIToken, error) {
	var t model.APIToken
	err := r.Scan(&t.ID, &t.UserID, &t.Username, &t.Name, &t.Hint, &t.CreatedAt, &t.ExpiresAt, &t.LastUsedAt)
	return t, err
}

// Tokens lists the tokens of one user, or of everyone when username is "".
func (s *Store) Tokens(ctx context.Context, username string) ([]model.APIToken, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+tokenCols+" FROM api_tokens "+
		"WHERE tenant = $1 AND ($2 = '' OR lower(username) = lower($2)) ORDER BY id DESC", s.tenant, username)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.APIToken{}
	for rows.Next() {
		t, err := scanToken(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (s *Store) TokenByHash(ctx context.Context, hash string) (model.APIToken, error) {
	t, err := scanToken(s.pool.QueryRow(ctx, "SELECT "+tokenCols+" FROM api_tokens WHERE tenant = $1 AND token_hash = $2",
		s.tenant, hash))
	return t, notFound(err, "Token", "")
}

func (s *Store) CreateToken(ctx context.Context, t model.APIToken, hash string) (int64, error) {
	var id int64
	err := s.pool.QueryRow(ctx, `
		INSERT INTO api_tokens (tenant, user_id, username, name, token_hash, hint, created_at, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
		s.tenant, t.UserID, t.Username, t.Name, hash, t.Hint, t.CreatedAt, t.ExpiresAt).Scan(&id)
	return id, mapErr(err)
}

// DeleteToken revokes a token of username's, or anyone's when username is "".
func (s *Store) DeleteToken(ctx context.Context, id int64, username string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM api_tokens WHERE tenant = $1 AND id = $2
		AND ($3 = '' OR lower(username) = lower($3))`, s.tenant, id, username)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return httpx.NotFound("Token", id)
	}
	return nil
}

func (s *Store) TouchToken(ctx context.Context, id, now int64) {
	_, _ = s.pool.Exec(ctx, `UPDATE api_tokens SET last_used_at = $2 WHERE id = $1`, id, now)
}

// ------------------------------------------------------------------ audit

const auditLogCols = `al.id, al.at, al.username, al.via, al.method, al.path, al.status, al.address`

var auditFields = &fiql.Fields{Plain: map[string]fiql.Field{
	"id":      {Column: "al.id", Kind: fiql.Number},
	"at":      {Column: "al.at", Kind: fiql.Number},
	"user":    {Column: "al.username"},
	"via":     {Column: "al.via"},
	"method":  {Column: "al.method"},
	"path":    {Column: "al.path"},
	"status":  {Column: "al.status", Kind: fiql.Number},
	"address": {Column: "al.address"},
}}

func (s *Store) AddAudit(ctx context.Context, e model.AuditEntry) error {
	_, err := s.pool.Exec(ctx, `INSERT INTO audit_log (tenant, at, username, via, method, path, status, address)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		s.tenant, e.At, e.User, e.Via, e.Method, e.Path, e.Status, e.Address)
	return err
}

// AuditLog is a page of the log, newest first unless sorted otherwise; q
// filters it (user==alice;status=ge=400).
func (s *Store) AuditLog(ctx context.Context, p httpx.Page) ([]model.AuditEntry, int64, error) {
	a := &Args{}
	out := []model.AuditEntry{}
	total, err := list(ctx, s.pool, listSpec{
		Select: auditLogCols, From: "audit_log al", Where: []string{"al.tenant = " + a.Bind(s.tenant)},
		Fields: auditFields, DefaultSort: "al.id DESC",
	}, a, p, func(rows pgx.Rows) error {
		var e model.AuditEntry
		if err := rows.Scan(&e.ID, &e.At, &e.User, &e.Via, &e.Method, &e.Path, &e.Status, &e.Address); err != nil {
			return err
		}
		out = append(out, e)
		return nil
	})
	return out, total, err
}

// PruneAudit forgets entries older than before.
func (s *Store) PruneAudit(ctx context.Context, before int64) (int64, error) {
	tag, err := s.pool.Exec(ctx, `DELETE FROM audit_log WHERE tenant = $1 AND at < $2`, s.tenant, before)
	return tag.RowsAffected(), err
}
