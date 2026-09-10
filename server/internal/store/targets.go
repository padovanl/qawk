package store

import (
	"context"
	"strings"

	"github.com/jackc/pgx/v5"

	"qawk/internal/fiql"
	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Targets: the devices, their attributes and their state.

const targetCols = "t.id, t.controller_id, t.name, t.description, t.target_group, t.target_type_id, " +
	"(SELECT tt.name FROM target_types tt WHERE tt.id = t.target_type_id), t.security_token, t.address, " +
	"t.last_request_at, t.installed_at, t.assigned_ds_id, t.installed_ds_id, t.update_status, t.request_attributes, " +
	"t.auto_confirm_active, t.auto_confirm_initiator, t.auto_confirm_remark, t.auto_confirm_at, " +
	"t.created_at, t.created_by, t.last_modified_at, t.last_modified_by"

func scanTarget(r pgx.Row) (model.Target, error) {
	var t model.Target
	err := r.Scan(&t.ID, &t.ControllerID, &t.Name, &t.Description, &t.Group, &t.TypeID, &t.TypeName, &t.SecurityToken, &t.Address,
		&t.LastRequestAt, &t.InstalledAt, &t.AssignedDSID, &t.InstalledDSID, &t.UpdateStatus, &t.RequestAttributes,
		&t.AutoConfirmActive, &t.AutoConfirmInitiator, &t.AutoConfirmRemark, &t.AutoConfirmAt,
		&t.CreatedAt, &t.CreatedBy, &t.LastModifiedAt, &t.LastModifiedBy)
	return t, err
}

// Targets lists targets; extra narrows the list with conditions on t (the
// targets of a tag, of a rollout group, with a set assigned...).
func (s *Store) Targets(ctx context.Context, page httpx.Page, extra func(a *Args) []string) ([]model.Target, int64, error) {
	a := &Args{}
	where := []string{"t.tenant = " + a.Bind(s.tenant)}
	if extra != nil {
		where = append(where, extra(a)...)
	}
	out := []model.Target{}
	total, err := list(ctx, s.pool, listSpec{
		Select: targetCols, From: "targets t", Where: where, Fields: targetFields, DefaultSort: "t.id ASC",
	}, a, page, func(r pgx.Rows) error {
		t, err := scanTarget(r)
		out = append(out, t)
		return err
	})
	return out, total, err
}

func (s *Store) Target(ctx context.Context, q Q, controllerID string) (model.Target, error) {
	t, err := scanTarget(q.QueryRow(ctx, "SELECT "+targetCols+" FROM targets t WHERE t.tenant = $1 AND t.controller_id = $2",
		s.tenant, controllerID))
	return t, notFound(err, "Target", controllerID)
}

// TargetForUpdate reads a target and locks its row until the transaction
// ends: a device's feedback and an operator's assignment to the same target
// must not interleave.
func (s *Store) TargetForUpdate(ctx context.Context, tx pgx.Tx, controllerID string) (model.Target, error) {
	t, err := scanTarget(tx.QueryRow(ctx, "SELECT "+targetCols+" FROM targets t WHERE t.tenant = $1 AND t.controller_id = $2 FOR UPDATE",
		s.tenant, controllerID))
	return t, notFound(err, "Target", controllerID)
}

func (s *Store) TargetByID(ctx context.Context, q Q, id int64) (model.Target, error) {
	t, err := scanTarget(q.QueryRow(ctx, "SELECT "+targetCols+" FROM targets t WHERE t.tenant = $1 AND t.id = $2", s.tenant, id))
	return t, notFound(err, "Target", id)
}

func (s *Store) CreateTarget(ctx context.Context, tx pgx.Tx, user string, now int64, t model.Target) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO targets (tenant, controller_id, name, description, target_type_id, security_token, address,
		                     last_request_at, update_status, request_attributes, target_group, `+auditCols+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $12, $13) RETURNING id`,
		s.tenant, t.ControllerID, t.Name, t.Description, t.TypeID, t.SecurityToken, t.Address,
		t.LastRequestAt, t.UpdateStatus, t.RequestAttributes, t.Group, now, user).Scan(&id)
	return id, err
}

// UpdateTarget writes the fields an operator can change.
func (s *Store) UpdateTarget(ctx context.Context, tx pgx.Tx, user string, now int64, t model.Target) error {
	_, err := tx.Exec(ctx, `UPDATE targets SET name = $3, description = $4, target_type_id = $5, security_token = $6,
		address = $7, request_attributes = $8, target_group = $9, last_modified_at = $10, last_modified_by = $11
		WHERE tenant = $1 AND id = $2`,
		s.tenant, t.ID, t.Name, t.Description, t.TypeID, t.SecurityToken, t.Address, t.RequestAttributes, t.Group, now, user)
	return err
}

// SetGroup puts targets in a group, or takes them out of theirs (nil).
func (s *Store) SetGroup(ctx context.Context, tx pgx.Tx, ids []int64, group *string, user string, now int64) error {
	_, err := tx.Exec(ctx, `UPDATE targets SET target_group = $3, last_modified_at = $4, last_modified_by = $5
		WHERE tenant = $1 AND id = ANY($2)`, s.tenant, ids, group, now, user)
	return err
}

// GroupNames lists every group in use.
func (s *Store) GroupNames(ctx context.Context) ([]string, error) {
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT target_group FROM targets
		WHERE tenant = $1 AND target_group IS NOT NULL ORDER BY 1`, s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var g string
		if err := rows.Scan(&g); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// InGroupOf is the condition "in this group" -- or, with subgroups, in it or
// anywhere below it.
func InGroupOf(group string, subgroups bool) func(a *Args) []string {
	return func(a *Args) []string {
		if subgroups {
			g := a.Bind(group)
			return []string{"(t.target_group = " + g + " OR t.target_group LIKE " + a.Bind(likePrefix(group)) + ")"}
		}
		return []string{"t.target_group = " + a.Bind(group)}
	}
}

func likePrefix(g string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(g) + "/%"
}

// IDsOf maps controller ids onto target ids; an unknown one is a 404.
func (s *Store) IDsOf(ctx context.Context, q Q, controllerIDs []string) ([]int64, error) {
	ids := make([]int64, 0, len(controllerIDs))
	for _, c := range controllerIDs {
		t, err := s.Target(ctx, q, c)
		if err != nil {
			return nil, err
		}
		ids = append(ids, t.ID)
	}
	return ids, nil
}

func (s *Store) DeleteTarget(ctx context.Context, tx pgx.Tx, id int64) error {
	_, err := tx.Exec(ctx, `DELETE FROM targets WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return err
}

// Polled records a device's poll: when, and from where. It does not touch
// lastModifiedAt -- a poll is not a change to the target.
func (s *Store) Polled(ctx context.Context, q Q, id int64, now int64, address *string) error {
	_, err := q.Exec(ctx, `UPDATE targets SET last_request_at = $2, address = COALESCE($3, address) WHERE id = $1`,
		id, now, address)
	return err
}

// SetState writes the assignment state of a target in one statement.
func (s *Store) SetState(ctx context.Context, tx pgx.Tx, id int64, assigned, installed *int64, installedAt *int64, status string) error {
	_, err := tx.Exec(ctx, `UPDATE targets SET assigned_ds_id = $2, installed_ds_id = $3,
		installed_at = COALESCE($4, installed_at), update_status = $5 WHERE id = $1`,
		id, assigned, installed, installedAt, status)
	return err
}

func (s *Store) SetRequestAttributes(ctx context.Context, q Q, id int64, v bool) error {
	_, err := q.Exec(ctx, `UPDATE targets SET request_attributes = $2 WHERE id = $1`, id, v)
	return err
}

func (s *Store) SetAutoConfirm(ctx context.Context, tx pgx.Tx, id int64, active bool, initiator, remark *string, now int64) error {
	var at *int64
	if active {
		at = &now
	}
	_, err := tx.Exec(ctx, `UPDATE targets SET auto_confirm_active = $2, auto_confirm_initiator = $3,
		auto_confirm_remark = $4, auto_confirm_at = $5 WHERE id = $1`, id, active, initiator, remark, at)
	return err
}

// ----------------------------------------------------------------- attributes

func (s *Store) Attributes(ctx context.Context, q Q, targetID int64) (map[string]string, error) {
	rows, err := q.Query(ctx, `SELECT attr_key, attr_value FROM target_attributes WHERE target_id = $1 ORDER BY attr_key`, targetID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// PutAttributes applies a device's configData: merge (the default) adds and
// overwrites, replace drops what is not in the new set, remove deletes the
// given keys.
func (s *Store) PutAttributes(ctx context.Context, tx pgx.Tx, targetID int64, mode string, data map[string]string) error {
	switch mode {
	case "replace":
		if _, err := tx.Exec(ctx, `DELETE FROM target_attributes WHERE target_id = $1`, targetID); err != nil {
			return err
		}
	case "remove":
		keys := make([]string, 0, len(data))
		for k := range data {
			keys = append(keys, k)
		}
		_, err := tx.Exec(ctx, `DELETE FROM target_attributes WHERE target_id = $1 AND attr_key = ANY($2)`, targetID, keys)
		return err
	}
	for k, v := range data {
		if _, err := tx.Exec(ctx, `INSERT INTO target_attributes (target_id, attr_key, attr_value) VALUES ($1, $2, $3)
			ON CONFLICT (target_id, attr_key) DO UPDATE SET attr_value = EXCLUDED.attr_value`, targetID, k, v); err != nil {
			return err
		}
	}
	return nil
}

// ------------------------------------------------------------------ matching

// Matching returns the ids of the targets a query selects, in id order, with
// extra conditions on t. Rollouts and auto-assignment are built on it.
func (s *Store) Matching(ctx context.Context, q Q, query string, extra func(a *Args) []string) ([]int64, error) {
	a := &Args{}
	cond, e := fiql.Compile(query, targetFields, a.Bind)
	if e != nil {
		return nil, e
	}
	where := "t.tenant = " + a.Bind(s.tenant) + " AND " + cond
	if extra != nil {
		for _, c := range extra(a) {
			where += " AND " + c
		}
	}
	rows, err := q.Query(ctx, "SELECT t.id FROM targets t WHERE "+where+" ORDER BY t.id", a.Values()...)
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

// CheckQuery validates a target query without running it for real, so that a
// filter or a rollout is refused when it is saved, not when it is used.
func (s *Store) CheckQuery(query string) error {
	a := &Args{}
	_, e := fiql.Compile(query, targetFields, a.Bind)
	if e != nil {
		return e
	}
	return nil
}
