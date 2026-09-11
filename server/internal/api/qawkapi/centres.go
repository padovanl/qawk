package qawkapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"qawk/internal/auth"
	"qawk/internal/httpx"
)

// /qawk/v1/centres: a device's centre is in a channel, and the device follows
// (a Qawk addition). See service/centres.go.

func (a *API) centreRoutes(r chi.Router) {
	r.With(auth.Require("READ_TARGET")).Get("/centres", a.listCentres)
	r.With(auth.Require("UPDATE_TARGET")).Put("/centres", a.setCentres)
	r.With(auth.Require("UPDATE_TARGET")).Put("/centres/settings", a.setCentreSettings)
}

func (a *API) listCentres(w http.ResponseWriter, r *http.Request) {
	field, cs, err := a.svc.Centres(r.Context())
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(cs))
	for _, c := range cs {
		out = append(out, map[string]any{"centre": c.Centre, "name": c.Name, "fleetId": c.FleetID, "fleet": c.Fleet,
			"colour": c.Colour, "devices": c.Devices, "onChannel": c.OnChannel})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"field": field, "content": out, "total": len(out)})
}

// setCentres puts centres in a channel: {"centres": [...], "fleetId": n}
// (0 or null: in none). Their devices follow.
func (a *API) setCentres(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Centres []string `json:"centres"`
		FleetID *int64   `json:"fleetId"`
	}
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	if b.FleetID != nil && *b.FleetID == 0 {
		b.FleetID = nil
	}
	if err := a.svc.SetCentres(r.Context(), auth.User(r.Context()), b.Centres, b.FleetID); err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.listCentres(w, r)
}

// setCentreSettings: {"field": "attribute.centerid"}.
func (a *API) setCentreSettings(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Field string `json:"field"`
	}
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	if err := a.svc.SetCentreField(r.Context(), auth.User(r.Context()), b.Field); err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.listCentres(w, r)
}
