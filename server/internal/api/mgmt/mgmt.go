// Package mgmt is hawkBit's Management API (/rest/v1): what the console, our
// scripts and hawkbit-simple-ui talk to.
//
// Every endpoint answers with the JSON hawkBit 1.1.0 answers with for the same
// request -- same fields, same links, same error codes -- because the console
// was written against hawkBit and must work unchanged against either. What
// Qawk offers beyond hawkBit is not here: it lives under /qawk/v1.
package mgmt

import (
	"log/slog"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"qawk/internal/auth"
	"qawk/internal/config"
	"qawk/internal/httpx"
	"qawk/internal/service"
	"qawk/internal/store"
)

type API struct {
	svc *service.Service
	st  *store.Store
	cfg config.Config
	log *slog.Logger
}

func New(svc *service.Service, cfg config.Config, log *slog.Logger) *API {
	return &API{svc: svc, st: svc.Store(), cfg: cfg, log: log}
}

// Routes mounts /rest/v1. Each route states the hawkBit permission it
// needs; auth.Require enforces it (see auth for who has which).
func (a *API) Routes(r chi.Router) {
	r.Route("/rest/v1", func(r chi.Router) {
		r.Use(a.svc.Directory().Middleware)
		a.targetRoutes(r)
		a.actionRoutes(r)
		a.softwareRoutes(r)
		a.setRoutes(r)
		a.typeRoutes(r)
		a.tagRoutes(r)
		a.filterRoutes(r)
		a.rolloutRoutes(r)
		a.systemRoutes(r)
	})
}

// need is shorthand for a route that requires a permission.
func need(r chi.Router, perm string) chi.Router { return r.With(auth.Require(perm)) }

// ------------------------------------------------------------------ helpers

// base is the root every Management link is built on.
func (a *API) base(r *http.Request) string {
	return httpx.Base(r, a.cfg.PublicURL) + "/rest/v1"
}

func user(r *http.Request) string { return auth.User(r.Context()) }

func (a *API) tx(r *http.Request, fn func(tx pgx.Tx, now int64) error) error {
	return a.st.Tx(r.Context(), user(r), fn)
}

func pageOf(w http.ResponseWriter, r *http.Request) (httpx.Page, bool) {
	p, e := httpx.ParsePage(r)
	if e != nil {
		httpx.WriteError(w, e)
		return p, false
	}
	return p, true
}

// pathID reads a numeric path parameter; a malformed one is the 404 hawkBit
// gives for an id that does not exist.
func pathID(w http.ResponseWriter, r *http.Request, name, entity string) (int64, bool) {
	v, err := strconv.ParseInt(chi.URLParam(r, name), 10, 64)
	if err != nil {
		httpx.WriteError(w, httpx.NotFound(entity, chi.URLParam(r, name)))
		return 0, false
	}
	return v, true
}

func sendList(w http.ResponseWriter, content []map[string]any, total int64) {
	if content == nil {
		content = []map[string]any{}
	}
	httpx.WriteJSON(w, http.StatusOK, httpx.Paged{Content: content, Total: total, Size: len(content)})
}

func sendOK(w http.ResponseWriter, v any)      { httpx.WriteJSON(w, http.StatusOK, v) }
func sendCreated(w http.ResponseWriter, v any) { httpx.WriteJSON(w, http.StatusCreated, v) }

// noContent is hawkBit's answer to a delete or a command.
func noContent(w http.ResponseWriter) { w.WriteHeader(http.StatusNoContent) }

func fail(w http.ResponseWriter, err error) { httpx.WriteError(w, err) }

// decode reads a body, answering 400 for one that does not parse.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	if e := httpx.Decode(r, v); e != nil {
		httpx.WriteError(w, e)
		return false
	}
	return true
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
