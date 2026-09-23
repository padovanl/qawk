// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package mgmt

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/tenantcfg"
)

func (a *API) systemRoutes(r chi.Router) {
	need(r, "READ_TENANT_CONFIGURATION").Get("/system/configs", a.listConfigs)
	need(r, "TENANT_CONFIGURATION").Put("/system/configs", a.putConfigs)
	need(r, "READ_TENANT_CONFIGURATION").Get("/system/configs/{keyName}", a.getConfig)
	need(r, "TENANT_CONFIGURATION").Put("/system/configs/{keyName}", a.putConfig)
	need(r, "TENANT_CONFIGURATION").Delete("/system/configs/{keyName}", a.deleteConfig)
	r.Get("/userinfo", a.userInfo)
}

func (a *API) listConfigs(w http.ResponseWriter, r *http.Request) {
	all, err := a.st.Configs(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	b := a.base(r)
	out := J{}
	for k, v := range all {
		out[k] = configJSON(b, k, v)
	}
	sendOK(w, out)
}

func (a *API) getConfig(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "keyName")
	if !configKnown(key) {
		fail(w, httpx.NotFound("TenantConfiguration", key))
		return
	}
	v, err := a.st.Config(r.Context(), a.st.DB(), key)
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, configJSON(a.base(r), key, v))
}

// setConfigs validates every value against its key before storing any of
// them, so a batch with one bad value changes nothing.
func (a *API) setConfigs(w http.ResponseWriter, r *http.Request, values map[string]any) bool {
	norm := map[string]any{}
	for k, v := range values {
		key, known := tenantcfg.Lookup(k)
		if !known {
			fail(w, httpx.NotFound("TenantConfiguration", k))
			return false
		}
		nv, err := tenantcfg.Normalize(key, v)
		if err != nil {
			fail(w, httpx.Custom(400, "hawkbit.server.error.configValueInvalid",
				"org.eclipse.hawkbit.tenancy.configuration.validator.TenantConfigurationValidatorException", err.Error()))
			return false
		}
		norm[k] = nv
	}
	if err := a.tx(r, func(tx pgx.Tx, now int64) error {
		for k, v := range norm {
			if err := a.st.SetConfig(r.Context(), tx, user(r), now, k, v); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		fail(w, err)
		return false
	}
	return true
}

func (a *API) putConfig(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Value any `json:"value"`
	}
	if !decode(w, r, &body) {
		return
	}
	key := chi.URLParam(r, "keyName")
	if a.setConfigs(w, r, map[string]any{key: body.Value}) {
		a.getConfig(w, r)
	}
}

func (a *API) putConfigs(w http.ResponseWriter, r *http.Request) {
	var body map[string]any
	if !decode(w, r, &body) {
		return
	}
	if a.setConfigs(w, r, body) {
		a.listConfigs(w, r)
	}
}

func (a *API) deleteConfig(w http.ResponseWriter, r *http.Request) {
	key := chi.URLParam(r, "keyName")
	if !configKnown(key) {
		fail(w, httpx.NotFound("TenantConfiguration", key))
		return
	}
	if err := a.tx(r, func(tx pgx.Tx, now int64) error { return a.st.DeleteConfig(r.Context(), tx, key) }); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) userInfo(w http.ResponseWriter, r *http.Request) {
	sendOK(w, J{"username": user(r), "tenant": a.st.Tenant()})
}
