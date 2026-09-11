package qawkapi

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"go.yaml.in/yaml/v3"

	"qawk/internal/auth"
	"qawk/internal/httpx"
	"qawk/internal/model"
)

// /qawk/v1/systemtypes, /manifests, /systemdeployments: systems updated as a
// whole, after Mender Orchestrator (a Qawk addition). Topologies and
// manifests also come and go as Mender's YAML.

func (a *API) systemRoutes(r chi.Router) {
	rt, ro := auth.Require("READ_TARGET"), auth.Require("READ_ROLLOUT")
	r.With(rt).Get("/systemtypes", a.listSystemTypes)
	r.With(auth.Require("CREATE_TARGET")).Post("/systemtypes", a.saveSystemType(false))
	r.With(auth.Require("CREATE_TARGET")).Post("/systemtypes/import", a.importTopology)
	r.With(rt).Get("/systemtypes/{tid}", a.getSystemType)
	r.With(rt).Get("/systemtypes/{tid}/topology.yaml", a.exportTopology)
	r.With(auth.Require("UPDATE_TARGET")).Put("/systemtypes/{tid}", a.saveSystemType(true))
	r.With(auth.Require("DELETE_TARGET")).Delete("/systemtypes/{tid}", a.deleteSystemType)
	r.With(rt).Get("/systemtypes/{tid}/systems", a.listSystems)

	r.With(ro).Get("/manifests", a.listManifests)
	r.With(auth.Require("CREATE_ROLLOUT")).Post("/manifests", a.saveManifest(false))
	r.With(auth.Require("CREATE_ROLLOUT")).Post("/manifests/import", a.importManifest)
	r.With(ro).Get("/manifests/{mid}", a.getManifest)
	r.With(ro).Get("/manifests/{mid}/manifest.yaml", a.exportManifest)
	r.With(auth.Require("UPDATE_ROLLOUT")).Put("/manifests/{mid}", a.saveManifest(true))
	r.With(auth.Require("DELETE_ROLLOUT")).Delete("/manifests/{mid}", a.deleteManifest)

	r.With(ro).Get("/systemdeployments", a.listSystemDeployments)
	r.With(auth.Require("CREATE_ROLLOUT")).Post("/systemdeployments", a.createSystemDeployment)
	r.With(ro).Get("/systemdeployments/{did}", a.getSystemDeployment)
	r.With(auth.Require("DELETE_ROLLOUT")).Delete("/systemdeployments/{did}", a.deleteSystemDeployment)
	for _, c := range []string{"start", "pause", "resume", "abort"} {
		r.With(auth.Require("HANDLE_ROLLOUT")).Post("/systemdeployments/{did}/"+c, a.systemDeploymentCommand(c))
	}
	r.With(auth.Require("HANDLE_ROLLOUT")).Post("/systemdeployments/{did}/runs/{rid}/rollback", a.rollbackSystem)
}

// ------------------------------------------------------------ system types

func systemTypeJSON(t model.SystemType) map[string]any {
	comps := make([]map[string]any, 0, len(t.Components))
	for _, c := range t.Components {
		comps = append(comps, map[string]any{"componentType": c.ComponentType, "match": c.Match})
	}
	return map[string]any{"id": t.ID, "name": t.Name, "description": t.Description, "systemKey": t.KeyField,
		"groupKey": t.GroupField, "components": comps, "createdAt": t.CreatedAt, "createdBy": t.CreatedBy,
		"lastModifiedAt": t.LastModifiedAt, "lastModifiedBy": t.LastModifiedBy}
}

type systemTypeBody struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	SystemKey   string `json:"systemKey"`
	GroupKey    string `json:"groupKey"`
	Components  []struct {
		ComponentType string `json:"componentType"`
		Match         string `json:"match"`
	} `json:"components"`
}

func (a *API) sendSystemType(w http.ResponseWriter, r *http.Request, id int64, status int) {
	t, err := a.st.SystemType(r.Context(), a.st.DB(), id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, status, systemTypeJSON(t))
}

func (a *API) listSystemTypes(w http.ResponseWriter, r *http.Request) {
	ts, err := a.st.SystemTypes(r.Context())
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(ts))
	for _, t := range ts {
		out = append(out, systemTypeJSON(t))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

func (a *API) getSystemType(w http.ResponseWriter, r *http.Request) {
	if id, ok := pathInt(w, r, "tid", "SystemType"); ok {
		a.sendSystemType(w, r, id, http.StatusOK)
	}
}

func (a *API) saveSystemType(update bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var id int64
		if update {
			var ok bool
			if id, ok = pathInt(w, r, "tid", "SystemType"); !ok {
				return
			}
		}
		var b systemTypeBody
		if e := httpx.Decode(r, &b); e != nil {
			httpx.WriteError(w, e)
			return
		}
		t := model.SystemType{ID: id, Name: b.Name, Description: b.Description, KeyField: strings.TrimSpace(b.SystemKey),
			GroupField: strings.TrimSpace(b.GroupKey)}
		for _, c := range b.Components {
			t.Components = append(t.Components, model.SystemComponent{ComponentType: strings.TrimSpace(c.ComponentType),
				Match: strings.TrimSpace(c.Match)})
		}
		nid, err := a.svc.SaveSystemType(r.Context(), auth.User(r.Context()), t)
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		status := http.StatusCreated
		if update {
			status = http.StatusOK
		}
		a.sendSystemType(w, r, nid, status)
	}
}

func (a *API) deleteSystemType(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "tid", "SystemType")
	if !ok {
		return
	}
	if err := a.svc.DeleteSystemType(r.Context(), auth.User(r.Context()), id); err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// listSystems: the systems of a type, as its devices say.
func (a *API) listSystems(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "tid", "SystemType")
	if !ok {
		return
	}
	in, err := a.svc.Systems(r.Context(), id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	labels, err := a.st.FleetLabels(r.Context())
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(in))
	for _, s := range in {
		e := map[string]any{"system": s.Key, "devices": s.Devices, "components": s.Components, "group": s.Group,
			"fleetId": nil, "fleet": nil, "colour": nil, "mixed": s.Mixed}
		if l, ok := labels[s.FleetID]; ok {
			e["fleetId"], e["fleet"], e["colour"] = s.FleetID, l.Name, l.Colour
		}
		out = append(out, e)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

// Mender's topology, with where Qawk finds the system key and the devices of
// each component (qawk_system_key, qawk_match).
type topologyYAML struct {
	APIVersion    string `yaml:"api_version"`
	Kind          string `yaml:"kind"`
	SystemType    string `yaml:"system_type"`
	Description   string `yaml:"description,omitempty"`
	QawkSystemKey string `yaml:"qawk_system_key"`
	QawkGroupKey  string `yaml:"qawk_group_key,omitempty"`
	Components    []struct {
		ComponentType string   `yaml:"component_type"`
		Interface     string   `yaml:"interface,omitempty"`
		InterfaceArgs []string `yaml:"interface_args,omitempty"`
		QawkMatch     string   `yaml:"qawk_match,omitempty"`
	} `yaml:"components"`
}

func readYAML(w http.ResponseWriter, r *http.Request, v any) bool {
	b, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err == nil {
		err = yaml.Unmarshal(b, v)
	}
	if err != nil {
		httpx.WriteError(w, httpx.Validation("that is not the YAML expected: "+err.Error()))
		return false
	}
	return true
}

func (a *API) importTopology(w http.ResponseWriter, r *http.Request) {
	var y topologyYAML
	if !readYAML(w, r, &y) {
		return
	}
	if y.Kind != "" && y.Kind != "topology" {
		httpx.WriteError(w, httpx.Validation(`a topology has kind: "topology"`))
		return
	}
	t := model.SystemType{Name: y.SystemType, Description: y.Description, KeyField: y.QawkSystemKey,
		GroupField: y.QawkGroupKey}
	if t.KeyField == "" {
		t.KeyField = "metadata.system"
	}
	for _, c := range y.Components {
		m := c.QawkMatch
		if m == "" {
			m = "attribute.device_type==" + c.ComponentType
		}
		t.Components = append(t.Components, model.SystemComponent{ComponentType: c.ComponentType, Match: m})
	}
	if old, err := a.st.SystemTypeByName(r.Context(), a.st.DB(), t.Name); err == nil {
		t.ID = old.ID
	}
	id, err := a.svc.SaveSystemType(r.Context(), auth.User(r.Context()), t)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.sendSystemType(w, r, id, http.StatusOK)
}

func (a *API) exportTopology(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "tid", "SystemType")
	if !ok {
		return
	}
	t, err := a.st.SystemType(r.Context(), a.st.DB(), id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	y := topologyYAML{APIVersion: "mender/v1", Kind: "topology", SystemType: t.Name, Description: t.Description,
		QawkSystemKey: t.KeyField, QawkGroupKey: t.GroupField}
	for _, c := range t.Components {
		y.Components = append(y.Components, struct {
			ComponentType string   `yaml:"component_type"`
			Interface     string   `yaml:"interface,omitempty"`
			InterfaceArgs []string `yaml:"interface_args,omitempty"`
			QawkMatch     string   `yaml:"qawk_match,omitempty"`
		}{ComponentType: c.ComponentType, QawkMatch: c.Match})
	}
	writeYAML(w, t.Name+"-topology.yaml", y)
}

func writeYAML(w http.ResponseWriter, name string, v any) {
	b, err := yaml.Marshal(v)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/yaml; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename=%q`, name))
	_, _ = w.Write(b)
}

// ------------------------------------------------------------ manifests

func manifestJSON(m model.Manifest) map[string]any {
	comps := make([]map[string]any, 0, len(m.Components))
	for _, c := range m.Components {
		comps = append(comps, map[string]any{"componentType": c.ComponentType, "distributionSetId": c.DSID,
			"distributionSet": c.DSLabel, "order": c.Order})
	}
	return map[string]any{"id": m.ID, "name": m.Name, "description": m.Description, "systemTypeId": m.SystemTypeID,
		"systemType": m.SystemType, "components": comps, "createdAt": m.CreatedAt, "createdBy": m.CreatedBy,
		"lastModifiedAt": m.LastModifiedAt, "lastModifiedBy": m.LastModifiedBy}
}

type manifestBody struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	SystemTypeID int64  `json:"systemTypeId"`
	Components   []struct {
		ComponentType     string `json:"componentType"`
		DistributionSetID int64  `json:"distributionSetId"`
		Order             int    `json:"order"`
	} `json:"components"`
}

func (a *API) sendManifest(w http.ResponseWriter, r *http.Request, id int64, status int) {
	m, err := a.st.Manifest(r.Context(), a.st.DB(), id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, status, manifestJSON(m))
}

func (a *API) listManifests(w http.ResponseWriter, r *http.Request) {
	ms, err := a.st.Manifests(r.Context())
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		out = append(out, manifestJSON(m))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

func (a *API) getManifest(w http.ResponseWriter, r *http.Request) {
	if id, ok := pathInt(w, r, "mid", "Manifest"); ok {
		a.sendManifest(w, r, id, http.StatusOK)
	}
}

func (a *API) saveManifest(update bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var id int64
		if update {
			var ok bool
			if id, ok = pathInt(w, r, "mid", "Manifest"); !ok {
				return
			}
		}
		var b manifestBody
		if e := httpx.Decode(r, &b); e != nil {
			httpx.WriteError(w, e)
			return
		}
		m := model.Manifest{ID: id, Name: b.Name, Description: b.Description, SystemTypeID: b.SystemTypeID}
		for _, c := range b.Components {
			m.Components = append(m.Components, model.ManifestComponent{ComponentType: c.ComponentType,
				DSID: c.DistributionSetID, Order: c.Order})
		}
		nid, err := a.svc.SaveManifest(r.Context(), auth.User(r.Context()), m)
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		status := http.StatusCreated
		if update {
			status = http.StatusOK
		}
		a.sendManifest(w, r, nid, status)
	}
}

func (a *API) deleteManifest(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "mid", "Manifest")
	if !ok {
		return
	}
	if err := a.svc.DeleteManifest(r.Context(), auth.User(r.Context()), id); err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

type manifestStrategy struct {
	Order int `yaml:"order"`
}

type manifestComponentYAML struct {
	ArtifactName   string           `yaml:"artifact_name"`
	UpdateStrategy manifestStrategy `yaml:"update_strategy"`
}

// Mender's manifest: artifact_name is the distribution set, "name:version"
// (or a name alone: its newest version).
type manifestYAML struct {
	APIVersion            string                           `yaml:"api_version"`
	Kind                  string                           `yaml:"kind"`
	Name                  string                           `yaml:"name"`
	Description           string                           `yaml:"description,omitempty"`
	SystemTypesCompatible []string                         `yaml:"system_types_compatible"`
	ComponentTypes        map[string]manifestComponentYAML `yaml:"component_types"`
}

func (a *API) importManifest(w http.ResponseWriter, r *http.Request) {
	var y manifestYAML
	if !readYAML(w, r, &y) {
		return
	}
	if y.Kind != "" && y.Kind != "manifest" {
		httpx.WriteError(w, httpx.Validation(`a manifest has kind: "manifest"`))
		return
	}
	if len(y.SystemTypesCompatible) != 1 {
		httpx.WriteError(w, httpx.Validation("name exactly one system type in system_types_compatible"))
		return
	}
	t, err := a.st.SystemTypeByName(r.Context(), a.st.DB(), y.SystemTypesCompatible[0])
	if err != nil {
		httpx.WriteError(w, httpx.Validation("there is no system type "+y.SystemTypesCompatible[0]+": import its topology first"))
		return
	}
	m := model.Manifest{Name: y.Name, Description: y.Description, SystemTypeID: t.ID}
	for comp, c := range y.ComponentTypes {
		ds, err := a.st.SetByLabel(r.Context(), c.ArtifactName)
		if err != nil {
			httpx.WriteError(w, httpx.Validation(fmt.Sprintf("%s: there is no distribution set %q", comp, c.ArtifactName)))
			return
		}
		m.Components = append(m.Components, model.ManifestComponent{ComponentType: comp, DSID: ds, Order: c.UpdateStrategy.Order})
	}
	sort.Slice(m.Components, func(i, j int) bool { return m.Components[i].Order < m.Components[j].Order })
	id, err := a.svc.SaveManifest(r.Context(), auth.User(r.Context()), m)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.sendManifest(w, r, id, http.StatusCreated)
}

func (a *API) exportManifest(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "mid", "Manifest")
	if !ok {
		return
	}
	m, err := a.st.Manifest(r.Context(), a.st.DB(), id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	y := manifestYAML{APIVersion: "mender/v1", Kind: "manifest", Name: m.Name, Description: m.Description,
		SystemTypesCompatible: []string{m.SystemType}, ComponentTypes: map[string]manifestComponentYAML{}}
	for _, c := range m.Components {
		y.ComponentTypes[c.ComponentType] = manifestComponentYAML{ArtifactName: c.DSLabel,
			UpdateStrategy: manifestStrategy{Order: c.Order}}
	}
	writeYAML(w, m.Name+".yaml", y)
}

// ------------------------------------------------------------ deployments

func (a *API) systemDeploymentJSON(r *http.Request, d model.SystemDeployment, withRuns bool) (map[string]any, error) {
	runs, err := a.st.Runs(r.Context(), a.st.DB(), d.ID)
	if err != nil {
		return nil, err
	}
	counts := map[string]int{"pending": 0, "running": 0, "succeeded": 0, "rolling_back": 0, "rolled_back": 0, "skipped": 0}
	ids := make([]int64, 0, len(runs))
	for _, rn := range runs {
		counts[rn.Status]++
		ids = append(ids, rn.ID)
	}
	out := map[string]any{
		"id": d.ID, "name": d.Name, "manifestId": d.ManifestID, "manifest": d.Manifest, "systems": d.Systems,
		"fleetId": d.FleetID, "fleet": d.Fleet, "groups": d.Groups,
		"maxParallel": d.MaxParallel, "maxFailed": d.MaxFailed, "actionType": d.ActionType, "status": d.Status,
		"reason": d.Reason, "startedBy": d.StartedBy, "startedAt": d.StartedAt, "finishedAt": d.FinishedAt,
		"createdAt": d.CreatedAt, "createdBy": d.CreatedBy, "total": len(runs), "counts": counts,
	}
	if withRuns {
		comps, err := a.st.RunComponents(r.Context(), ids)
		if err != nil {
			return nil, err
		}
		list := make([]map[string]any, 0, len(runs))
		for _, rn := range runs {
			cs := make([]map[string]any, 0)
			for _, c := range comps[rn.ID] {
				cs = append(cs, map[string]any{"componentType": c.ComponentType, "order": c.Order, "devices": c.Devices,
					"onSet": c.OnSet, "back": c.Back})
			}
			list = append(list, map[string]any{"id": rn.ID, "system": rn.SystemKey, "status": rn.Status,
				"currentOrder": rn.CurrentOrder, "reason": rn.Reason, "startedAt": rn.StartedAt,
				"finishedAt": rn.FinishedAt, "components": cs})
		}
		out["runs"] = list
	}
	return out, nil
}

type systemDeploymentBody struct {
	Name        string   `json:"name"`
	ManifestID  int64    `json:"manifestId"`
	Systems     []string `json:"systems"`
	FleetID     *int64   `json:"fleetId"`
	Groups      []string `json:"groups"`
	MaxParallel int      `json:"maxParallel"`
	MaxFailed   int      `json:"maxFailed"`
	ActionType  string   `json:"actionType"`
}

func (a *API) sendSystemDeployment(w http.ResponseWriter, r *http.Request, id int64, status int) {
	d, err := a.st.SystemDeployment(r.Context(), a.st.DB(), id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	j, err := a.systemDeploymentJSON(r, d, true)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, status, j)
}

func (a *API) listSystemDeployments(w http.ResponseWriter, r *http.Request) {
	ds, err := a.st.SystemDeployments(r.Context(), nil)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(ds))
	for _, d := range ds {
		j, err := a.systemDeploymentJSON(r, d, false)
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		out = append(out, j)
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

func (a *API) createSystemDeployment(w http.ResponseWriter, r *http.Request) {
	var b systemDeploymentBody
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	d := model.SystemDeployment{Name: b.Name, ManifestID: b.ManifestID, Systems: b.Systems, FleetID: b.FleetID,
		Groups: b.Groups, MaxParallel: b.MaxParallel, MaxFailed: b.MaxFailed, ActionType: b.ActionType}
	if len(d.Systems) == 0 {
		d.Systems = nil
	}
	if d.FleetID != nil && *d.FleetID == 0 {
		d.FleetID = nil
	}
	if len(d.Groups) == 0 {
		d.Groups = nil
	}
	id, err := a.svc.CreateSystemDeployment(r.Context(), auth.User(r.Context()), d)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.sendSystemDeployment(w, r, id, http.StatusCreated)
}

func (a *API) getSystemDeployment(w http.ResponseWriter, r *http.Request) {
	if id, ok := pathInt(w, r, "did", "SystemDeployment"); ok {
		a.sendSystemDeployment(w, r, id, http.StatusOK)
	}
}

func (a *API) deleteSystemDeployment(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "did", "SystemDeployment")
	if !ok {
		return
	}
	if err := a.svc.DeleteSystemDeployment(r.Context(), auth.User(r.Context()), id); err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func reasonOf(w http.ResponseWriter, r *http.Request) (string, bool) {
	var b struct {
		Reason string `json:"reason"`
	}
	if r.ContentLength != 0 {
		if e := httpx.Decode(r, &b); e != nil {
			httpx.WriteError(w, e)
			return "", false
		}
	}
	return b.Reason, true
}

func (a *API) systemDeploymentCommand(cmd string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, ok := pathInt(w, r, "did", "SystemDeployment")
		if !ok {
			return
		}
		reason, ok := reasonOf(w, r)
		if !ok {
			return
		}
		if err := a.svc.SystemDeploymentCommand(r.Context(), auth.User(r.Context()), id, cmd, reason); err != nil {
			httpx.WriteError(w, err)
			return
		}
		a.sendSystemDeployment(w, r, id, http.StatusOK)
	}
}

func (a *API) rollbackSystem(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "did", "SystemDeployment")
	if !ok {
		return
	}
	run, ok := pathInt(w, r, "rid", "SystemRun")
	if !ok {
		return
	}
	reason, ok := reasonOf(w, r)
	if !ok {
		return
	}
	if err := a.svc.RollbackSystem(r.Context(), auth.User(r.Context()), id, run, reason); err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.sendSystemDeployment(w, r, id, http.StatusOK)
}
