package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"qawk/internal/model"
)

// Fleets (a Qawk addition).

const fleetCols = `f.id, f.name, f.description, f.colour, f.rule, f.ds_id,
	(SELECT x.name || ':' || x.version FROM distribution_sets x WHERE x.id = f.ds_id), f.action_type,
	f.created_at, f.created_by, f.last_modified_at, f.last_modified_by,
	(SELECT count(*) FROM targets t WHERE t.fleet_id = f.id),
	(SELECT count(*) FROM targets t WHERE t.fleet_id = f.id AND f.ds_id IS NOT NULL AND t.installed_ds_id = f.ds_id),
	(SELECT count(*) FROM targets t WHERE t.fleet_id = f.id AND EXISTS (SELECT 1 FROM actions a WHERE a.target_id = t.id AND a.active)),
	(SELECT count(*) FROM targets t WHERE t.fleet_id = f.id AND t.update_status = 'error')`

func scanFleet(r pgx.Row) (model.Fleet, error) {
	var f model.Fleet
	err := r.Scan(&f.ID, &f.Name, &f.Description, &f.Colour, &f.Rule, &f.DSID, &f.DSLabel, &f.ActionType,
		&f.CreatedAt, &f.CreatedBy, &f.LastModifiedAt, &f.LastModifiedBy,
		&f.Members, &f.OnRelease, &f.Updating, &f.Failed)
	return f, err
}

func (s *Store) Fleets(ctx context.Context) ([]model.Fleet, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+fleetCols+" FROM fleets f WHERE f.tenant = $1 ORDER BY f.name", s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Fleet{}
	for rows.Next() {
		f, err := scanFleet(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Store) Fleet(ctx context.Context, q Q, id int64) (model.Fleet, error) {
	f, err := scanFleet(q.QueryRow(ctx, "SELECT "+fleetCols+" FROM fleets f WHERE f.tenant = $1 AND f.id = $2", s.tenant, id))
	return f, notFound(err, "Fleet", id)
}

func (s *Store) CreateFleet(ctx context.Context, tx pgx.Tx, user string, now int64, f model.Fleet) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `INSERT INTO fleets (tenant, name, description, colour, rule, ds_id, action_type, `+auditCols+`)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8, $9) RETURNING id`,
		s.tenant, f.Name, f.Description, f.Colour, f.Rule, f.DSID, f.ActionType, now, user).Scan(&id)
	return id, err
}

func (s *Store) UpdateFleet(ctx context.Context, tx pgx.Tx, user string, now int64, f model.Fleet) error {
	_, err := tx.Exec(ctx, `UPDATE fleets SET name = $3, description = $4, colour = $5, rule = $6, ds_id = $7,
		action_type = $8, last_modified_at = $9, last_modified_by = $10 WHERE tenant = $1 AND id = $2`,
		s.tenant, f.ID, f.Name, f.Description, f.Colour, f.Rule, f.DSID, f.ActionType, now, user)
	return err
}

func (s *Store) DeleteFleet(ctx context.Context, tx pgx.Tx, id int64) error {
	_, err := tx.Exec(ctx, `DELETE FROM fleets WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return err
}

// SetFleet puts targets in a fleet, or takes them out of theirs (nil).
func (s *Store) SetFleet(ctx context.Context, tx pgx.Tx, ids []int64, fleet *int64) error {
	_, err := tx.Exec(ctx, `UPDATE targets SET fleet_id = $3 WHERE tenant = $1 AND id = ANY($2)`, s.tenant, ids, fleet)
	return err
}

// InFleet is the condition "a member of this fleet", for target lists.
func InFleet(id int64) func(a *Args) []string {
	return func(a *Args) []string { return []string{"t.fleet_id = " + a.Bind(id)} }
}
