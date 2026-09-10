// Package server puts Qawk together: the store, the artifact store, the
// service, and the three HTTP surfaces on top of it -- the Management API
// (/rest/v1), the device API (/{tenant}/controller/v1) and the API
// description (/v3/api-docs) -- plus Qawk's own /qawk/v1.
package server

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"qawk/internal/api/ddi"
	"qawk/internal/api/mgmt"
	"qawk/internal/artifact"
	"qawk/internal/config"
	"qawk/internal/openapi"
	"qawk/internal/service"
	"qawk/internal/store"
)

// Version is set at build time (-ldflags "-X qawk/internal/server.Version=...").
var Version = "dev"

type Server struct {
	cfg     config.Config
	svc     *service.Service
	log     *slog.Logger
	handler http.Handler
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

	r := chi.NewRouter()
	r.Use(middleware.Recoverer)
	r.Use(requestLog(log))

	// Qawk's own surface: what this server is and what it offers beyond
	// hawkBit. The console asks this first; hawkBit answers 404, and the
	// console then behaves exactly as it does with hawkBit.
	r.Get("/qawk/v1/info", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"name":     "Qawk",
			"version":  Version,
			"api":      "v1",
			"hawkbit":  "1.1.0",
			"tenant":   cfg.Tenant,
			"features": []string{},
		})
	})
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

	return &Server{cfg: cfg, svc: svc, log: log, handler: r}, nil
}

func (s *Server) Handler() http.Handler { return s.handler }

// RunBackground runs the rollout engine and auto-assignment until ctx ends.
func (s *Server) RunBackground(ctx context.Context) { s.svc.Run(ctx) }

// requestLog logs each request at debug level, and errors at info: with a
// fleet polling every thirty seconds, logging every poll at info would bury
// everything else.
func requestLog(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			start := time.Now()
			next.ServeHTTP(ww, r)
			level := slog.LevelDebug
			if ww.Status() >= 500 {
				level = slog.LevelWarn
			}
			log.Log(r.Context(), level, "http", "method", r.Method, "path", r.URL.Path,
				"status", ww.Status(), "ms", time.Since(start).Milliseconds())
		})
	}
}
