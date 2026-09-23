// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

// Package store is Qawk's data access. Every SQL statement lives in this
// package, next to the struct it fills; nothing above it writes SQL.
package store

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"qawk/internal/fiql"
	"qawk/internal/httpx"
)

type Store struct {
	pool   *pgxpool.Pool
	tenant string

	cfgMu sync.Mutex
	cfg   map[string]cachedConfig
}

// Leader tries to become the one instance that runs the background jobs.
//
// Qawk can run as many instances as the load needs, all on one database;
// the HTTP side needs no coordination at all. The rollout engine and the
// auto-assignment must run in one place, though, or two instances would
// start the same group twice. A PostgreSQL session advisory lock picks that
// place: whoever holds it leads, and because the lock belongs to a
// connection, an instance that dies -- or loses its database -- loses the
// lock with it, and another takes over at its next attempt. No extra
// component, no configuration.
//
// ok is false when another instance leads. When it is true, alive reports
// whether the lock is still held, and release gives it up.
func (s *Store) Leader(ctx context.Context, key int64) (release func(), alive func(context.Context) bool, ok bool, err error) {
	conn, err := s.pool.Acquire(ctx)
	if err != nil {
		return nil, nil, false, err
	}
	var got bool
	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, key).Scan(&got); err != nil {
		conn.Release()
		return nil, nil, false, err
	}
	if !got {
		conn.Release()
		return nil, nil, false, nil
	}
	release = func() {
		_, _ = conn.Exec(context.Background(), `SELECT pg_advisory_unlock($1)`, key)
		conn.Release()
	}
	alive = func(ctx context.Context) bool { return conn.Ping(ctx) == nil }
	return release, alive, true, nil
}

func New(pool *pgxpool.Pool, tenant string) *Store {
	return &Store{pool: pool, tenant: tenant}
}

func (s *Store) Tenant() string { return s.tenant }

// Q is what both the pool and a transaction offer, so that a read can run
// inside a transaction or outside one with the same code.
type Q interface {
	Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

// DB is the pool, for reads that need no transaction.
func (s *Store) DB() Q { return s.pool }

// Tx runs fn in one transaction. now is the single timestamp for everything
// the transaction writes, so that a target and the action created with it
// carry the same createdAt, as they would in hawkBit.
func (s *Store) Tx(ctx context.Context, user string, fn func(tx pgx.Tx, now int64) error) error {
	_ = user // recorded by the callers, in the audit columns they write
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := fn(tx, httpx.Now()); err != nil {
		return mapErr(err)
	}
	return mapErr(tx.Commit(ctx))
}

// mapErr turns the database's refusals into the API errors hawkBit gives for
// the same situation.
func mapErr(err error) error {
	if err == nil {
		return nil
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		switch pg.Code {
		case "23505": // unique_violation
			return httpx.AlreadyExists("The given entity already exists in database")
		case "23503": // foreign_key_violation
			return httpx.Custom(409, "hawkbit.server.error.repo.entityNotFound",
				"org.eclipse.hawkbit.repository.exception.EntityNotFoundException",
				"a referenced entity does not exist or is still in use")
		}
	}
	return err
}

// notFound maps "no rows" to the API's 404 for that entity.
func notFound(err error, entity string, id any) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return httpx.NotFound(entity, id)
	}
	return err
}

// ------------------------------------------------------------------ args

// Args collects the parameters of a statement being built and hands out
// their placeholders. Everything a client sends goes through here.
type Args struct{ vals []any }

func (a *Args) Bind(v any) string {
	a.vals = append(a.vals, v)
	return "$" + strconv.Itoa(len(a.vals))
}

func (a *Args) Values() []any { return a.vals }

// ------------------------------------------------------------------ lists

// listSpec describes one entity's list query.
type listSpec struct {
	Select      string   // the columns, as the entity's scan expects them
	From        string   // FROM and joins, with the aliases the Fields use
	Where       []string // fixed conditions, their parameters already bound
	Fields      *fiql.Fields
	DefaultSort string // also the tie-breaker, so paging is stable
}

// list runs the count and the page of a list, with the client's q, sort,
// offset and limit. It returns the total, as hawkBit's envelope needs it.
func list(ctx context.Context, q Q, spec listSpec, a *Args, page httpx.Page, scan func(pgx.Rows) error) (int64, error) {
	cond, e := fiql.Compile(page.Q, spec.Fields, a.Bind)
	if e != nil {
		return 0, e
	}
	where := strings.Join(append([]string{cond}, spec.Where...), " AND ")
	order, e := fiql.Sort(page.Sort, spec.Fields, spec.DefaultSort)
	if e != nil {
		return 0, e
	}
	var total int64
	if err := q.QueryRow(ctx, "SELECT count(*) FROM "+spec.From+" WHERE "+where, a.vals...).Scan(&total); err != nil {
		return 0, err
	}
	sql := "SELECT " + spec.Select + " FROM " + spec.From + " WHERE " + where +
		" ORDER BY " + order + " LIMIT " + strconv.Itoa(page.Limit) + " OFFSET " + strconv.Itoa(page.Offset)
	rows, err := q.Query(ctx, sql, a.vals...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	for rows.Next() {
		if err := scan(rows); err != nil {
			return 0, err
		}
	}
	return total, rows.Err()
}

// all is a list with no paging, for the internal callers that need every row.
func all() httpx.Page { return httpx.Page{Limit: 1 << 30} }
