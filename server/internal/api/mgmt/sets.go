// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package mgmt

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/service"
	"qawk/internal/store"
)

func (a *API) setRoutes(r chi.Router) {
	need(r, "READ_REPOSITORY").Get("/distributionsets", a.listSets)
	need(r, "CREATE_REPOSITORY").Post("/distributionsets", a.createSets)
	need(r, "READ_REPOSITORY").Get("/distributionsets/{dsId}", a.getSet)
	need(r, "UPDATE_REPOSITORY").Put("/distributionsets/{dsId}", a.updateSet)
	need(r, "DELETE_REPOSITORY").Delete("/distributionsets/{dsId}", a.deleteSet)
	need(r, "READ_REPOSITORY").Get("/distributionsets/{dsId}/assignedSM", a.setModules)
	need(r, "UPDATE_REPOSITORY").Post("/distributionsets/{dsId}/assignedSM", a.addSetModules)
	need(r, "UPDATE_REPOSITORY").Delete("/distributionsets/{dsId}/assignedSM/{smId}", a.removeSetModule)
	need(r, "READ_TARGET").Get("/distributionsets/{dsId}/assignedTargets", a.setAssignedTargets)
	need(r, "UPDATE_TARGET").Post("/distributionsets/{dsId}/assignedTargets", a.assignSet)
	need(r, "READ_TARGET").Get("/distributionsets/{dsId}/installedTargets", a.setInstalledTargets)
	need(r, "READ_TARGET").Get("/distributionsets/{dsId}/autoAssignTargetFilters", a.setAutoFilters)
	need(r, "UPDATE_REPOSITORY").Post("/distributionsets/{dsId}/invalidate", a.invalidateSet)
	need(r, "READ_REPOSITORY").Get("/distributionsets/{dsId}/statistics", a.setStatistics("all"))
	need(r, "READ_REPOSITORY").Get("/distributionsets/{dsId}/statistics/actions", a.setStatistics("actions"))
	need(r, "READ_REPOSITORY").Get("/distributionsets/{dsId}/statistics/rollouts", a.setStatistics("rollouts"))
	need(r, "READ_REPOSITORY").Get("/distributionsets/{dsId}/statistics/autoassignments", a.setStatistics("autoassignments"))
	a.metadataRoutes(r, "/distributionsets/{dsId}", store.MetaDS, "READ_REPOSITORY", "UPDATE_REPOSITORY", a.setOwner)
}

func (a *API) setOf(w http.ResponseWriter, r *http.Request) (model.DistributionSet, bool) {
	dsID, found := pathID(w, r, "dsId", "DistributionSet")
	if !found {
		return model.DistributionSet{}, false
	}
	ds, err := a.st.DistributionSet(r.Context(), a.st.DB(), dsID)
	if err != nil {
		fail(w, err)
		return ds, false
	}
	return ds, true
}

func (a *API) setOwner(w http.ResponseWriter, r *http.Request) (int64, bool) {
	ds, found := a.setOf(w, r)
	return ds.ID, found
}

func (a *API) listSets(w http.ResponseWriter, r *http.Request) {
	p, good := pageOf(w, r)
	if !good {
		return
	}
	sets, total, err := a.st.DistributionSets(r.Context(), p, nil)
	if err != nil {
		fail(w, err)
		return
	}
	b := a.base(r)
	out := make([]map[string]any, 0, len(sets))
	for _, ds := range sets {
		out = append(out, dsJSON(b, ds, false))
	}
	sendList(w, out, total)
}

func (a *API) createSets(w http.ResponseWriter, r *http.Request) {
	var body []struct {
		Name                  string `json:"name"`
		Version               string `json:"version"`
		Type                  string `json:"type"`
		Description           string `json:"description"`
		RequiredMigrationStep bool   `json:"requiredMigrationStep"`
		Modules               []struct {
			ID int64 `json:"id"`
		} `json:"modules"`
	}
	if !decode(w, r, &body) {
		return
	}
	b := a.base(r)
	out := []map[string]any{}
	for _, d := range body {
		mods := make([]int64, len(d.Modules))
		for i, m := range d.Modules {
			mods[i] = m.ID
		}
		id, err := a.svc.CreateSet(r.Context(), user(r), service.SetDef{Name: d.Name, Version: d.Version,
			TypeKey: d.Type, Description: d.Description, RequiredMigrationStep: d.RequiredMigrationStep, Modules: mods})
		if err != nil {
			fail(w, err)
			return
		}
		ds, err := a.st.DistributionSet(r.Context(), a.st.DB(), id)
		if err != nil {
			fail(w, err)
			return
		}
		out = append(out, dsJSON(b, ds, false))
	}
	sendCreated(w, out)
}

func (a *API) getSet(w http.ResponseWriter, r *http.Request) {
	if ds, found := a.setOf(w, r); found {
		sendOK(w, dsJSON(a.base(r), ds, true))
	}
}

func (a *API) updateSet(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name                  *string `json:"name"`
		Version               *string `json:"version"`
		Description           *string `json:"description"`
		RequiredMigrationStep *bool   `json:"requiredMigrationStep"`
		Locked                *bool   `json:"locked"`
	}
	if !decode(w, r, &body) {
		return
	}
	ds, found := a.setOf(w, r)
	if !found {
		return
	}
	if body.Name != nil {
		ds.Name = *body.Name
	}
	if body.Version != nil {
		ds.Version = *body.Version
	}
	if body.Description != nil {
		ds.Description = *body.Description
	}
	if body.RequiredMigrationStep != nil {
		ds.RequiredMigrationStep = *body.RequiredMigrationStep
	}
	if body.Locked != nil {
		ds.Locked = *body.Locked
	}
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		if err := a.st.UpdateDS(r.Context(), tx, user(r), now, ds); err != nil {
			return err
		}
		if ds.Locked {
			if err := a.st.Lock(r.Context(), tx, ds.ID); err != nil {
				return err
			}
		}
		var err error
		ds, err = a.st.DistributionSet(r.Context(), tx, ds.ID)
		return err
	})
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, dsJSON(a.base(r), ds, true))
}

func (a *API) deleteSet(w http.ResponseWriter, r *http.Request) {
	ds, found := a.setOf(w, r)
	if !found {
		return
	}
	if err := a.tx(r, func(tx pgx.Tx, now int64) error {
		return a.st.DeleteDS(r.Context(), tx, user(r), now, ds.ID)
	}); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) setModules(w http.ResponseWriter, r *http.Request) {
	ds, found := a.setOf(w, r)
	if !found {
		return
	}
	p, good := pageOf(w, r)
	if !good {
		return
	}
	b := a.base(r)
	out := []map[string]any{}
	for i, m := range ds.Modules {
		if i >= p.Offset && len(out) < p.Limit {
			out = append(out, smJSON(b, m, false))
		}
	}
	sendList(w, out, int64(len(ds.Modules)))
}

func (a *API) addSetModules(w http.ResponseWriter, r *http.Request) {
	dsID, found := pathID(w, r, "dsId", "DistributionSet")
	if !found {
		return
	}
	var body []struct {
		ID int64 `json:"id"`
	}
	if !decode(w, r, &body) {
		return
	}
	ids := make([]int64, len(body))
	for i, b := range body {
		ids[i] = b.ID
	}
	if err := a.svc.AddModules(r.Context(), user(r), dsID, ids); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) removeSetModule(w http.ResponseWriter, r *http.Request) {
	dsID, found := pathID(w, r, "dsId", "DistributionSet")
	if !found {
		return
	}
	smID, found := pathID(w, r, "smId", "SoftwareModule")
	if !found {
		return
	}
	if err := a.svc.RemoveModule(r.Context(), user(r), dsID, smID); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) setAssignedTargets(w http.ResponseWriter, r *http.Request) {
	ds, found := a.setOf(w, r)
	if found {
		a.sendTargets(w, r, func(x *store.Args) []string { return []string{"t.assigned_ds_id = " + x.Bind(ds.ID)} })
	}
}

func (a *API) setInstalledTargets(w http.ResponseWriter, r *http.Request) {
	ds, found := a.setOf(w, r)
	if found {
		a.sendTargets(w, r, func(x *store.Args) []string { return []string{"t.installed_ds_id = " + x.Bind(ds.ID)} })
	}
}

// assignSet assigns a set to many targets. ?offline=true records it as
// already installed instead, for devices updated some other way.
func (a *API) assignSet(w http.ResponseWriter, r *http.Request) {
	ds, found := a.setOf(w, r)
	if !found {
		return
	}
	var body []assignBody
	if !decode(w, r, &body) {
		return
	}
	if r.URL.Query().Get("offline") == "true" {
		res := service.AssignResult{}
		for _, b := range body {
			t, err := a.st.Target(r.Context(), a.st.DB(), b.ID.String())
			if err != nil {
				fail(w, err)
				return
			}
			id, err := a.svc.OfflineInstalled(r.Context(), t, ds.Name, ds.Version)
			if err != nil {
				fail(w, err)
				return
			}
			res.Assigned++
			res.ActionIDs = append(res.ActionIDs, id)
			res.ControllerIDs = append(res.ControllerIDs, t.ControllerID)
		}
		sendOK(w, assignmentJSON(a.base(r), res))
		return
	}
	reqs := make([]service.AssignRequest, len(body))
	for i, b := range body {
		reqs[i] = b.request(b.ID.String())
	}
	res, err := a.svc.Assign(r.Context(), user(r), ds.ID, reqs)
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, assignmentJSON(a.base(r), res))
}

func (a *API) setAutoFilters(w http.ResponseWriter, r *http.Request) {
	ds, found := a.setOf(w, r)
	if !found {
		return
	}
	p, good := pageOf(w, r)
	if !good {
		return
	}
	fs, total, err := a.st.TargetFilters(r.Context(), p, func(x *store.Args) []string {
		return []string{"f.auto_assign_ds_id = " + x.Bind(ds.ID)}
	})
	if err != nil {
		fail(w, err)
		return
	}
	b := a.base(r)
	out := make([]map[string]any, 0, len(fs))
	for _, f := range fs {
		out = append(out, filterJSON(b, f, false))
	}
	sendList(w, out, total)
}

func (a *API) invalidateSet(w http.ResponseWriter, r *http.Request) {
	ds, found := a.setOf(w, r)
	if !found {
		return
	}
	var body struct {
		ActionCancelationType string `json:"actionCancelationType"`
		CancelRollouts        bool   `json:"cancelRollouts"`
	}
	if !decode(w, r, &body) {
		return
	}
	if err := a.svc.InvalidateSet(r.Context(), user(r), ds.ID, body.ActionCancelationType, body.CancelRollouts); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) setStatistics(which string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ds, found := a.setOf(w, r)
		if !found {
			return
		}
		ros, acts, auto, err := a.st.SetStatistics(r.Context(), ds.ID)
		if err != nil {
			fail(w, err)
			return
		}
		total := func(m map[string]int64) int64 {
			var n int64
			for _, v := range m {
				n += v
			}
			return n
		}
		withTotal := func(m map[string]int64) map[string]int64 {
			m["total"] = total(m)
			return m
		}
		switch which {
		case "actions":
			sendOK(w, J{"totalActionsPerStatus": withTotal(acts)})
		case "rollouts":
			sendOK(w, J{"totalRolloutsPerStatus": withTotal(ros)})
		case "autoassignments":
			sendOK(w, J{"totalAutoAssignments": auto})
		default:
			sendOK(w, J{"totalActionsPerStatus": withTotal(acts), "totalRolloutsPerStatus": withTotal(ros),
				"totalAutoAssignments": auto})
		}
	}
}

var _ = httpx.Now // keep the import for helpers used across files
