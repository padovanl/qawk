// Package server puts Qawk together: the store, the artifact store, the
// service, and the three HTTP surfaces on top of it -- the Management API
// (/rest/v1), the device API (/{tenant}/controller/v1) and the API
// description (/v3/api-docs) -- plus Qawk's own /qawk/v1.
package server

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"qawk/internal/api/ddi"
	"qawk/internal/api/mgmt"
	"qawk/internal/api/qawkapi"
	"qawk/internal/artifact"
	"qawk/internal/config"
	"qawk/internal/metrics"
	"qawk/internal/openapi"
	"qawk/internal/service"
	"qawk/internal/store"
	"qawk/internal/telemetry"
	"qawk/internal/users"
)

// Version is set at build time (-ldflags "-X qawk/internal/server.Version=...").
var Version = "dev"

type Server struct {
	cfg     config.Config
	svc     *service.Service
	log     *slog.Logger
	handler http.Handler
	tel     *telemetry.Telemetry
}

func New(ctx context.Context, cfg config.Config, pool *pgxpool.Pool, log *slog.Logger) (*Server, error) {
	st := store.New(pool, cfg.Tenant)
	if err := st.Seed(ctx); err != nil {
		return nil, err
	}
	// QAWK_POLLING_TIME is the interval until an operator sets another one;
	// once set through the API, the API's value wins.
	if v, err := st.Config(ctx, st.DB(), "pollingTime"); err == nil && v.Global && cfg.DefaultPollingTime != "" {
		if err := st.Tx(ctx, "system", func(tx pgx.Tx, now int64) error {
			return st.SetConfig(ctx, tx, "system", now, "pollingTime", cfg.DefaultPollingTime)
		}); err != nil {
			return nil, err
		}
	}
	art, err := artifact.NewFS(cfg.ArtifactDir)
	if err != nil {
		return nil, err
	}
	svc := service.New(st, art, log)
	dir := users.New(st, cfg.AdminUser, cfg.AdminPassword, cfg.AuditDays, log)
	if err := dir.Seed(ctx); err != nil {
		return nil, err
	}
	svc.SetDirectory(dir)

	m := metrics.New()
	m.AddSource(fleetGauges(st, svc))
	tel, err := telemetry.Setup(ctx, Version, m, log)
	if err != nil {
		return nil, err
	}

	r := chi.NewRouter()
	r.Use(keepSemicolons)
	r.Use(middleware.Recoverer)
	r.Use(requestLog(log, m))
	r.Use(ddiGate(cfg.DBMaxConns))
	// Prometheus: open, or behind QAWK_METRICS_TOKEN as a bearer token
	r.Handle("/metrics", m.Handler(cfg.MetricsToken))

	qawkapi.New(svc, cfg, Version).Routes(r)

	// /live says the process is up; /health that it can serve (the database
	// answers). Kubernetes restarts on the first and routes on the second: a
	// database outage takes every instance out of the load balancer, it does
	// not restart them all in a loop.
	r.Get("/live", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok\n")) })
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		if err := pool.Ping(r.Context()); err != nil {
			http.Error(w, "database: "+err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Write([]byte("ok\n"))
	})

	mgmt.New(svc, cfg, log).Routes(r)
	ddi.New(svc, cfg.Tenant, cfg.PublicURL, log).Routes(r)
	openapi.New(r, Version).Routes(r)

	return &Server{cfg: cfg, svc: svc, log: log, handler: tel.Wrap(r), tel: tel}, nil
}

// Shutdown flushes what OpenTelemetry still holds.
func (s *Server) Shutdown(ctx context.Context) error { return s.tel.Shutdown(ctx) }

func (s *Server) Handler() http.Handler { return s.handler }

// RunBackground runs the rollout engine and auto-assignment until ctx ends.
func (s *Server) RunBackground(ctx context.Context) { s.svc.Run(ctx) }

// ddiGate keeps a quarter of the database connections for everyone but the
// devices.
//
// Ten thousand devices coming online together -- after a power cut, or a
// crowd of simulated ones -- queue for the connection pool, and so did the
// console: pgx hands connections out in turn, and a Fleets page asked for
// behind thousands of polls waited 53 s. Now the device requests wait in a
// queue of their own for three quarters of the pool; the Management API, the
// console and the background engine always find a connection. Downloads are
// not held back: they touch the database once and then stream a file.
func ddiGate(conns int32) func(http.Handler) http.Handler {
	keep := conns / 4
	if keep < 1 {
		keep = 1
	}
	slots := make(chan struct{}, conns-keep)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if metrics.Surface(r.URL.Path) != "ddi" || strings.Contains(r.URL.Path, "/artifacts/") {
				next.ServeHTTP(w, r)
				return
			}
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
				next.ServeHTTP(w, r)
			case <-r.Context().Done():
			}
		})
	}
}

// keepSemicolons protects FIQL's ";" (AND) in a query string.
//
// hawkBit's clients -- our upload script among them -- write
// q=name==x;version==y with the ";" as it is. Tomcat takes it; Go, since 1.17,
// treats a ";" in a query as an invalid separator and silently drops the whole
// parameter, so the filter vanished and the request returned EVERYTHING. The
// upload script then took the first module it got, which was the wrong one.
// Escaping every ";" before anything parses the query keeps "q" whole.
func keepSemicolons(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.RawQuery, ";") {
			r.URL.RawQuery = strings.ReplaceAll(r.URL.RawQuery, ";", "%3B")
		}
		next.ServeHTTP(w, r)
	})
}

// requestLog logs each request at debug level, and errors at info: with a
// fleet polling every thirty seconds, logging every poll at info would bury
// everything else.
func requestLog(log *slog.Logger, m *metrics.Metrics) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			start := time.Now()
			next.ServeHTTP(ww, r)
			level := slog.LevelDebug
			if ww.Status() >= 500 {
				level = slog.LevelWarn
			}
			took, status := time.Since(start), ww.Status()
			if status == 0 {
				status = http.StatusOK
			}
			if r.URL.Path != "/metrics" {
				m.Observe(r.URL.Path, r.Method, status, took)
			}
			// the span, when there is one, is named after the route chi matched
			if span := trace.SpanFromContext(r.Context()); span.IsRecording() {
				if rc := chi.RouteContext(r.Context()); rc != nil && rc.RoutePattern() != "" {
					span.SetName(r.Method + " " + rc.RoutePattern())
					span.SetAttributes(attribute.String("http.route", rc.RoutePattern()))
				}
			}
			log.Log(r.Context(), level, "http", "method", r.Method, "path", r.URL.Path,
				"status", status, "ms", took.Milliseconds())
		})
	}
}
