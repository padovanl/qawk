package qawkapi

import (
	"fmt"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"qawk/internal/auth"
	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/store"
)

// /qawk/v1/fleets: beta, production, staging (a Qawk addition).

func (a *API) fleetRoutes(r chi.Router) {
	r.With(auth.Require("READ_TARGET")).Get("/fleets", a.listFleets)
	r.With(auth.Require("CREATE_TARGET")).Post("/fleets", a.createFleet)
	r.With(auth.Require("READ_TARGET")).Get("/fleets/{fleetId}", a.getFleet)
	r.With(auth.Require("UPDATE_TARGET")).Put("/fleets/{fleetId}", a.updateFleet)
	r.With(auth.Require("DELETE_TARGET")).Delete("/fleets/{fleetId}", a.deleteFleet)
	r.With(auth.Require("READ_TARGET")).Get("/fleets/{fleetId}/targets", a.fleetTargets)
	r.With(auth.Require("UPDATE_TARGET")).Put("/fleets/{fleetId}/targets", a.addToFleet)
	r.With(auth.Require("UPDATE_TARGET")).Delete("/fleets/{fleetId}/targets", a.removeFromFleet)
	r.With(auth.Require("UPDATE_TARGET")).Post("/fleets/{fleetId}/promote", a.promote)
}

func fleetJSON(f model.Fleet) map[string]any {
	return map[string]any{
		"id": f.ID, "name": f.Name, "description": f.Description, "colour": f.Colour, "rule": f.Rule,
		"distributionSetId": f.DSID, "distributionSet": f.DSLabel, "actionType": f.ActionType,
		"members": f.Members, "onRelease": f.OnRelease, "updating": f.Updating, "failed": f.Failed,
		"createdAt": f.CreatedAt, "createdBy": f.CreatedBy, "lastModifiedAt": f.LastModifiedAt,
		"lastModifiedBy": f.LastModifiedBy,
	}
}

func fleetID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "fleetId"), 10, 64)
	if err != nil {
		httpx.WriteError(w, httpx.NotFound("Fleet", chi.URLParam(r, "fleetId")))
		return 0, false
	}
	return id, true
}

func (a *API) listFleets(w http.ResponseWriter, r *http.Request) {
	fs, err := a.st.Fleets(r.Context())
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(fs))
	for _, f := range fs {
		out = append(out, fleetJSON(f))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

type fleetBody struct {
	Name              *string `json:"name"`
	Description       *string `json:"description"`
	Colour            *string `json:"colour"`
	Rule              *string `json:"rule"`
	DistributionSetID *int64  `json:"distributionSetId"`
	ActionType        *string `json:"actionType"`
}

func (b fleetBody) apply(f *model.Fleet) {
	if b.Name != nil {
		f.Name = *b.Name
	}
	if b.Description != nil {
		f.Description = *b.Description
	}
	if b.Colour != nil {
		f.Colour = b.Colour
	}
	if b.Rule != nil {
		f.Rule = b.Rule
	}
	if b.DistributionSetID != nil {
		if *b.DistributionSetID == 0 {
			f.DSID = nil // no release: members are left alone
		} else {
			f.DSID = b.DistributionSetID
		}
	}
	if b.ActionType != nil {
		f.ActionType = *b.ActionType
	}
}

func (a *API) createFleet(w http.ResponseWriter, r *http.Request) {
	var b fleetBody
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	var f model.Fleet
	b.apply(&f)
	id, err := a.svc.SaveFleet(r.Context(), auth.User(r.Context()), f)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.sendFleet(w, r, id, http.StatusCreated)
}

func (a *API) sendFleet(w http.ResponseWriter, r *http.Request, id int64, status int) {
	f, err := a.st.Fleet(r.Context(), a.st.DB(), id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, status, fleetJSON(f))
}

func (a *API) getFleet(w http.ResponseWriter, r *http.Request) {
	if id, found := fleetID(w, r); found {
		a.sendFleet(w, r, id, http.StatusOK)
	}
}

func (a *API) updateFleet(w http.ResponseWriter, r *http.Request) {
	id, found := fleetID(w, r)
	if !found {
		return
	}
	var b fleetBody
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	f, err := a.st.Fleet(r.Context(), a.st.DB(), id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	b.apply(&f)
	if _, err := a.svc.SaveFleet(r.Context(), auth.User(r.Context()), f); err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.sendFleet(w, r, id, http.StatusOK)
}

func (a *API) deleteFleet(w http.ResponseWriter, r *http.Request) {
	id, found := fleetID(w, r)
	if !found {
		return
	}
	if err := a.svc.Tx(r.Context(), auth.User(r.Context()), func(tx pgx.Tx, now int64) error {
		if _, err := a.st.Fleet(r.Context(), tx, id); err != nil {
			return err
		}
		return a.st.DeleteFleet(r.Context(), tx, id)
	}); err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// fleetTargets lists a fleet's members with what they run and should run.
func (a *API) fleetTargets(w http.ResponseWriter, r *http.Request) {
	id, found := fleetID(w, r)
	if !found {
		return
	}
	p, e := httpx.ParsePage(r)
	if e != nil {
		httpx.WriteError(w, e)
		return
	}
	ts, total, err := a.st.Targets(r.Context(), p, store.InFleet(id))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	labels := map[int64]string{}
	label := func(id *int64) any {
		if id == nil {
			return nil
		}
		if l, ok := labels[*id]; ok {
			return l
		}
		d, err := a.st.DistributionSet(r.Context(), a.st.DB(), *id)
		if err != nil {
			return nil
		}
		labels[*id] = d.Label()
		return labels[*id]
	}
	out := make([]map[string]any, 0, len(ts))
	for _, t := range ts {
		out = append(out, map[string]any{
			"controllerId": t.ControllerID, "name": t.Name, "updateStatus": t.UpdateStatus,
			"installed": label(t.InstalledDSID), "assigned": label(t.AssignedDSID),
			"lastControllerRequestAt": t.LastRequestAt,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, httpx.Paged{Content: out, Total: total, Size: len(out)})
}

func (a *API) members(w http.ResponseWriter, r *http.Request, fleet *int64) {
	var ids []string
	if e := httpx.Decode(r, &ids); e != nil {
		httpx.WriteError(w, e)
		return
	}
	if err := a.svc.SetMembers(r.Context(), auth.User(r.Context()), ids, fleet); err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) addToFleet(w http.ResponseWriter, r *http.Request) {
	if id, found := fleetID(w, r); found {
		a.members(w, r, &id)
	}
}

func (a *API) removeFromFleet(w http.ResponseWriter, r *http.Request) {
	if _, found := fleetID(w, r); found {
		a.members(w, r, nil)
	}
}

// promote: {"from": <fleet id>} -- this fleet gets the release that one runs.
func (a *API) promote(w http.ResponseWriter, r *http.Request) {
	id, found := fleetID(w, r)
	if !found {
		return
	}
	var b struct {
		From int64 `json:"from"`
	}
	if e := httpx.Decode(r, &b); e != nil || b.From == 0 {
		httpx.WriteError(w, httpx.Validation("give the fleet to promote from: {\"from\": <id>}"))
		return
	}
	if b.From == id {
		httpx.WriteError(w, httpx.Validation(fmt.Sprintf("fleet %d cannot be promoted from itself", id)))
		return
	}
	f, err := a.svc.Promote(r.Context(), auth.User(r.Context()), id, b.From)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, fleetJSON(f))
}
