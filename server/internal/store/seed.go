// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package store

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"
)

// Seed creates what a fresh hawkBit tenant starts with, the first time only.
//
// Two software module types (os, application) and three distribution set
// types (os, os_app, app), with the same keys, names, descriptions and module
// requirements as hawkBit 1.1.0, and default.ds.type pointing at os_app. Our
// scripts create sets by type key and never create these types themselves, so
// they have to be there. Running it again changes nothing.
func (s *Store) Seed(ctx context.Context) error {
	return s.Tx(ctx, "system", func(tx pgx.Tx, now int64) error {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM sm_types WHERE tenant = $1`, s.tenant).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return nil
		}
		smType := func(key, name, desc string, max int) (int64, error) {
			var id int64
			err := tx.QueryRow(ctx, `
				INSERT INTO sm_types (tenant, type_key, name, description, max_assignments, min_artifacts,
				                      created_at, created_by, last_modified_at, last_modified_by)
				VALUES ($1, $2, $3, $4, $5, 0, $6, 'system', $6, 'system') RETURNING id`,
				s.tenant, key, name, desc, max, now).Scan(&id)
			return id, err
		}
		dsType := func(key, name, desc string) (int64, error) {
			var id int64
			err := tx.QueryRow(ctx, `
				INSERT INTO ds_types (tenant, type_key, name, description,
				                      created_at, created_by, last_modified_at, last_modified_by)
				VALUES ($1, $2, $3, $4, $5, 'system', $5, 'system') RETURNING id`,
				s.tenant, key, name, desc, now).Scan(&id)
			return id, err
		}
		link := func(ds, sm int64, mandatory bool) error {
			_, err := tx.Exec(ctx, `INSERT INTO ds_type_sm_types (ds_type_id, sm_type_id, mandatory) VALUES ($1, $2, $3)`,
				ds, sm, mandatory)
			return err
		}

		osT, err := smType("os", "OS", "Core firmware or operating system", 1)
		if err != nil {
			return err
		}
		appT, err := smType("application", "Application", "Application Addons", 2147483647)
		if err != nil {
			return err
		}
		dsOS, err := dsType("os", "OS only", "Default type with Firmware/OS only.")
		if err != nil {
			return err
		}
		dsOSApp, err := dsType("os_app", "OS with app(s)", "Default type with Firmware/OS and optional app(s).")
		if err != nil {
			return err
		}
		dsApp, err := dsType("app", "App(s) only", "Default type with app(s) only.")
		if err != nil {
			return err
		}
		for _, l := range []struct {
			ds, sm int64
			m      bool
		}{{dsOS, osT, true}, {dsOSApp, osT, true}, {dsOSApp, appT, false}, {dsApp, appT, true}} {
			if err := link(l.ds, l.sm, l.m); err != nil {
				return err
			}
		}
		v, _ := json.Marshal(dsOSApp)
		_, err = tx.Exec(ctx, `
			INSERT INTO tenant_configs (tenant, config_key, config_value, created_at, created_by, last_modified_at, last_modified_by)
			VALUES ($1, 'default.ds.type', $2, $3, 'system', $3, 'system')
			ON CONFLICT DO NOTHING`, s.tenant, string(v), now)
		return err
	})
}
