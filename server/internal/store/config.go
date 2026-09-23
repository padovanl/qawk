// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package store

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"qawk/internal/model"
	"qawk/internal/tenantcfg"
)

// ConfigValue is one tenant configuration key as the API shows it: its
// value, and whether it is the default ("global") or was set here.
type ConfigValue struct {
	Value  any
	Global bool
	Audit  *model.Audit
}

// Config returns one key, falling back to its default.
func (s *Store) Config(ctx context.Context, q Q, key string) (ConfigValue, error) {
	k, ok := tenantcfg.Lookup(key)
	var raw []byte
	var a model.Audit
	err := q.QueryRow(ctx, `SELECT config_value, created_at, created_by, last_modified_at, last_modified_by
		FROM tenant_configs WHERE tenant = $1 AND config_key = $2`, s.tenant, key).
		Scan(&raw, &a.CreatedAt, &a.CreatedBy, &a.LastModifiedAt, &a.LastModifiedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		if !ok {
			return ConfigValue{}, errors.New("unknown configuration key " + key)
		}
		return ConfigValue{Value: k.Default, Global: true}, nil
	}
	if err != nil {
		return ConfigValue{}, err
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return ConfigValue{}, err
	}
	if ok {
		if nv, err := tenantcfg.Normalize(k, v); err == nil {
			v = nv
		}
	}
	return ConfigValue{Value: v, Global: false, Audit: &a}, nil
}

// Configs returns every key, set or default.
func (s *Store) Configs(ctx context.Context) (map[string]ConfigValue, error) {
	out := make(map[string]ConfigValue, len(tenantcfg.Keys))
	for _, k := range tenantcfg.Keys {
		out[k.Name] = ConfigValue{Value: k.Default, Global: true}
	}
	rows, err := s.pool.Query(ctx, `SELECT config_key, config_value, created_at, created_by, last_modified_at, last_modified_by
		FROM tenant_configs WHERE tenant = $1`, s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var raw []byte
		a := &model.Audit{}
		if err := rows.Scan(&key, &raw, &a.CreatedAt, &a.CreatedBy, &a.LastModifiedAt, &a.LastModifiedBy); err != nil {
			return nil, err
		}
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			return nil, err
		}
		if k, ok := tenantcfg.Lookup(key); ok {
			if nv, err := tenantcfg.Normalize(k, v); err == nil {
				v = nv
			}
		}
		out[key] = ConfigValue{Value: v, Global: false, Audit: a}
	}
	return out, rows.Err()
}

func (s *Store) SetConfig(ctx context.Context, tx pgx.Tx, user string, now int64, key string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `
		INSERT INTO tenant_configs (tenant, config_key, config_value, created_at, created_by, last_modified_at, last_modified_by)
		VALUES ($1, $2, $3, $4, $5, $4, $5)
		ON CONFLICT (tenant, config_key) DO UPDATE
		SET config_value = EXCLUDED.config_value, last_modified_at = EXCLUDED.last_modified_at,
		    last_modified_by = EXCLUDED.last_modified_by`, s.tenant, key, string(raw), now, user)
	s.forgetConfig(key)
	return err
}

func (s *Store) DeleteConfig(ctx context.Context, tx pgx.Tx, key string) error {
	_, err := tx.Exec(ctx, `DELETE FROM tenant_configs WHERE tenant = $1 AND config_key = $2`, s.tenant, key)
	s.forgetConfig(key)
	return err
}

// Typed accessors for the keys the server itself reads on every request.
//
// These are CACHED for a few seconds. A device poll reads several keys (is
// the gateway token enabled, what is it, what is the polling interval), and
// with ten thousand devices polling every thirty seconds that is over a
// thousand config queries a second for values that change a few times a
// year. The cache is per instance: a change made through the API is seen at
// once by the instance that made it (SetConfig clears it) and within
// configTTL by the others -- which is also how long a change could take to
// reach a device anyway, since devices only ask at their next poll.

const configTTL = 5 * time.Second

type cachedConfig struct {
	v  ConfigValue
	at time.Time
}

func (s *Store) cachedConfig(ctx context.Context, key string) (ConfigValue, error) {
	s.cfgMu.Lock()
	c, hit := s.cfg[key]
	s.cfgMu.Unlock()
	if hit && time.Since(c.at) < configTTL {
		return c.v, nil
	}
	v, err := s.Config(ctx, s.pool, key)
	if err != nil {
		return v, err
	}
	s.cfgMu.Lock()
	if s.cfg == nil {
		s.cfg = map[string]cachedConfig{}
	}
	s.cfg[key] = cachedConfig{v: v, at: time.Now()}
	s.cfgMu.Unlock()
	return v, nil
}

func (s *Store) forgetConfig(key string) {
	s.cfgMu.Lock()
	delete(s.cfg, key)
	s.cfgMu.Unlock()
}

func (s *Store) ConfigBool(ctx context.Context, key string) bool {
	v, err := s.cachedConfig(ctx, key)
	if err != nil {
		return false
	}
	b, _ := v.Value.(bool)
	return b
}

func (s *Store) ConfigString(ctx context.Context, key string) string {
	v, err := s.cachedConfig(ctx, key)
	if err != nil {
		return ""
	}
	str, _ := v.Value.(string)
	return str
}

func (s *Store) ConfigInt(ctx context.Context, key string) int64 {
	v, err := s.cachedConfig(ctx, key)
	if err != nil {
		return 0
	}
	switch n := v.Value.(type) {
	case int64:
		return n
	case float64:
		return int64(n)
	}
	return 0
}
