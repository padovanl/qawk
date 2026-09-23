// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

// Package qawkapi is /qawk/v1: what Qawk offers beyond hawkBit.
//
// Nothing here changes what hawkBit's API returns. A client written for
// hawkBit never sees it; the console asks /qawk/v1/info and uses the rest
// only when the server says it has it.
package qawkapi

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"qawk/internal/auth"
	"qawk/internal/config"
	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/service"
	"qawk/internal/store"
)

// Features is what /qawk/v1/info announces. The console turns a feature on
// only when its name is here.
var Features = []string{"download-progress", "fleets", "users", "tokens", "audit", "pipeline", "metrics", "batch", "deployments", "systems", "centres"}

type API struct {
	svc     *service.Service
	st      *store.Store
	cfg     config.Config
	version string
}

func New(svc *service.Service, cfg config.Config, version string) *API {
	return &API{svc: svc, st: svc.Store(), cfg: cfg, version: version}
}

func (a *API) Routes(r chi.Router) {
	r.Route("/qawk/v1", func(r chi.Router) {
		// What this server is: public, like hawkBit's API description, so a
		// console can tell what it is talking to before anyone signs in.
		r.Get("/info", a.info)
		r.Group(func(r chi.Router) {
			r.Use(a.svc.Directory().Middleware)
			r.With(auth.Require("READ_TARGET")).Get("/downloads", a.downloads)
			r.With(auth.Require("READ_TARGET")).Get("/actions/{actionId}/downloads", a.actionDownloads)
			a.fleetRoutes(r)
			a.systemRoutes(r)
			a.centreRoutes(r)
			// one request for a page of targets, one for what is going on
			r.With(auth.Require("READ_TARGET")).Get("/targets/state", a.targetStates)
			r.With(auth.Require("READ_TARGET")).Get("/targets/attributes", a.targetAttributes)
			r.With(auth.Require("READ_TARGET")).Get("/deployments", a.deployments)
			a.userRoutes(r)
		})
	})
}

func (a *API) info(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"name": "Qawk", "version": a.version, "api": "v1", "hawkbit": "1.1.0",
		"tenant": a.st.Tenant(), "features": Features,
		// The licence and where this build's source is. Public, like the rest
		// of this answer: the AGPL's offer is worth nothing if you have to be
		// signed in to read it.
		"licence": "AGPL-3.0-or-later", "source": a.cfg.SourceURL,
	})
}

func downloadJSON(d model.Download) map[string]any {
	m := map[string]any{
		"actionId": d.ActionID, "controllerId": d.ControllerID, "artifactId": d.ArtifactID,
		"filename": d.Filename, "size": d.Size, "bytes": d.Bytes, "ranged": d.Ranged,
		"startedAt": d.StartedAt, "updatedAt": d.UpdatedAt, "completedAt": d.CompletedAt,
		"percent": nil,
	}
	// a percentage only means something for a whole-file download
	if !d.Ranged && d.Size > 0 {
		m["percent"] = d.Bytes * 100 / d.Size
	}
	return m
}

// downloads: the downloads of every open action, in one request.
func (a *API) downloads(w http.ResponseWriter, r *http.Request) {
	ds, err := a.st.ActiveDownloads(r.Context())
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(ds))
	for _, d := range ds {
		out = append(out, downloadJSON(d))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

func (a *API) actionDownloads(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "actionId"), 10, 64)
	if err != nil {
		httpx.WriteError(w, httpx.NotFound("Action", chi.URLParam(r, "actionId")))
		return
	}
	ds, err := a.st.DownloadsOf(r.Context(), id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(ds))
	for _, d := range ds {
		out = append(out, downloadJSON(d))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}
