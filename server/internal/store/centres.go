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

// Centres (a Qawk addition): a device says which centre it is in, a centre is
// in a channel (a fleet), and every device of it follows.

// DefaultCentreField is where a device says its centre, until set otherwise.
const DefaultCentreField = "attribute.centerid"

// CentreField is the field a device says its centre with.
func (s *Store) CentreField(ctx context.Context) (string, error) {
	var v string
	err := s.pool.QueryRow(ctx, `SELECT value FROM qawk_settings WHERE tenant = $1 AND key = 'centre_field'`,
		s.tenant).Scan(&v)
	if errors.Is(err, pgx.ErrNoRows) {
		return DefaultCentreField, nil
	}
	return v, err
}

func (s *Store) SetCentreField(ctx context.Context, tx pgx.Tx, field string) error {
	_, err := tx.Exec(ctx, `INSERT INTO qawk_settings (tenant, key, value) VALUES ($1, 'centre_field', $2)
		ON CONFLICT (tenant, key) DO UPDATE SET value = EXCLUDED.value`, s.tenant, field)
	return err
}

// centreSource is the table and columns a centre field is read from.
func centreSource(field string) (table, keyCol, valCol, key string, err error) {
	switch {
	case strings.HasPrefix(field, "attribute."):
		return "target_attributes", "attr_key", "attr_value", strings.TrimPrefix(field, "attribute."), nil
	case strings.HasPrefix(field, "metadata."):
		return "target_metadata", "meta_key", "meta_value", strings.TrimPrefix(field, "metadata."), nil
	}
	return "", "", "", "", fmt.Errorf("a centre field is attribute.<key> or metadata.<key>, not %q", field)
}

// Centres lists every centre the devices name, and every centre put in a
// channel, with how many devices each has and how many are in its channel.
func (s *Store) Centres(ctx context.Context, field string) ([]model.Centre, error) {
	tbl, kc, vc, key, err := centreSource(field)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		WITH seen AS (
			SELECT x.%[3]s AS centre, count(*) AS devices,
			       count(*) FILTER (WHERE t.fleet_id = m.fleet_id) AS on_channel
			FROM %[1]s x JOIN targets t ON t.id = x.target_id
			LEFT JOIN centres m ON m.tenant = t.tenant AND m.centre = x.%[3]s
			WHERE t.tenant = $1 AND x.%[2]s = $2 AND x.%[3]s <> ''
			GROUP BY x.%[3]s)
		SELECT c.centre, coalesce(m.name, ''), m.fleet_id, f.name, f.colour,
		       coalesce(seen.devices, 0), coalesce(seen.on_channel, 0)
		FROM (SELECT centre FROM seen UNION SELECT centre FROM centres WHERE tenant = $1) c
		LEFT JOIN seen ON seen.centre = c.centre
		LEFT JOIN centres m ON m.tenant = $1 AND m.centre = c.centre
		LEFT JOIN fleets f ON f.id = m.fleet_id
		ORDER BY c.centre`, tbl, kc, vc), s.tenant, key)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Centre{}
	for rows.Next() {
		var c model.Centre
		if err := rows.Scan(&c.Centre, &c.Name, &c.FleetID, &c.Fleet, &c.Colour, &c.Devices, &c.OnChannel); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SetCentres puts centres in a fleet (nil: in none).
func (s *Store) SetCentres(ctx context.Context, tx pgx.Tx, user string, now int64, centres []string, fleet *int64) error {
	_, err := tx.Exec(ctx, `INSERT INTO centres (tenant, centre, fleet_id, last_modified_at, last_modified_by)
		SELECT $1, c, $3, $4, $5 FROM unnest($2::text[]) AS c
		ON CONFLICT (tenant, centre) DO UPDATE SET fleet_id = EXCLUDED.fleet_id,
		    last_modified_at = EXCLUDED.last_modified_at, last_modified_by = EXCLUDED.last_modified_by`,
		s.tenant, centres, fleet, now, user)
	return err
}

// CentreStrays finds the devices that are not in their centre's fleet --
// but for those lent to a temporary fleet, which stay until sent home --
// by the fleet they should be in.
func (s *Store) CentreStrays(ctx context.Context, field string) (map[int64][]int64, error) {
	tbl, kc, vc, key, err := centreSource(field)
	if err != nil {
		return nil, err
	}
	rows, err := s.pool.Query(ctx, fmt.Sprintf(`
		SELECT t.id, m.fleet_id FROM %[1]s x
		JOIN targets t ON t.id = x.target_id
		JOIN centres m ON m.tenant = t.tenant AND m.centre = x.%[3]s AND m.fleet_id IS NOT NULL
		LEFT JOIN fleets cur ON cur.id = t.fleet_id
		WHERE t.tenant = $1 AND x.%[2]s = $2 AND t.fleet_id IS DISTINCT FROM m.fleet_id
		  AND NOT coalesce(cur.temporary, false)`, tbl, kc, vc), s.tenant, key)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64][]int64{}
	for rows.Next() {
		var id, f int64
		if err := rows.Scan(&id, &f); err != nil {
			return nil, err
		}
		out[f] = append(out[f], id)
	}
	return out, rows.Err()
}

// CentresOf says, for these targets, which centre each is in and that
// centre's fleet (absent: no centre).
func (s *Store) CentresOf(ctx context.Context, q Q, ids []int64, field string) (map[int64]model.CentreOf, error) {
	out := map[int64]model.CentreOf{}
	if len(ids) == 0 {
		return out, nil
	}
	tbl, kc, vc, key, err := centreSource(field)
	if err != nil {
		return nil, err
	}
	rows, err := q.Query(ctx, fmt.Sprintf(`
		SELECT x.target_id, x.%[3]s, m.fleet_id FROM %[1]s x
		LEFT JOIN centres m ON m.tenant = $1 AND m.centre = x.%[3]s
		WHERE x.target_id = ANY($2) AND x.%[2]s = $3 AND x.%[3]s <> ''`, tbl, kc, vc), s.tenant, ids, key)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var c model.CentreOf
		if err := rows.Scan(&id, &c.Centre, &c.FleetID); err != nil {
			return nil, err
		}
		out[id] = c
	}
	return out, rows.Err()
}
