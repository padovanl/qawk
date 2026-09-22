package qawkapi

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"qawk/internal/auth"
	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/service"
)

// /qawk/v1/fleets and /qawk/v1/releases: fleets and the release pipeline (a
// Qawk addition). See service/fleets.go for what they do.

func (a *API) fleetRoutes(r chi.Router) {
	read, update := auth.Require("READ_TARGET"), auth.Require("UPDATE_TARGET")
	r.With(read).Get("/fleets", a.listFleets)
	r.With(auth.Require("CREATE_TARGET")).Post("/fleets", a.createFleet)
	r.With(read).Get("/fleets/{fleetId}", a.getFleet)
	r.With(update).Put("/fleets/{fleetId}", a.updateFleet)
	r.With(auth.Require("DELETE_TARGET")).Delete("/fleets/{fleetId}", a.deleteFleet)
	r.With(read).Get("/fleets/{fleetId}/targets", a.fleetTargets)
	r.With(update).Put("/fleets/{fleetId}/targets", a.addToFleet)
	r.With(update).Delete("/fleets/{fleetId}/targets", a.removeFromFleet)
	r.With(update).Post("/fleets/{fleetId}/return", a.returnHome)
	r.With(read).Get("/fleets/{fleetId}/gate", a.gate)
	r.With(update).Post("/fleets/{fleetId}/promote", a.promote)
	r.With(read).Get("/fleets/{fleetId}/releases", a.fleetReleases)
	r.With(update).Post("/fleets/{fleetId}/resume", a.resume)
	r.With(update).Put("/fleets/{fleetId}/freeze", a.freeze)
	r.With(update).Delete("/fleets/{fleetId}/freeze", a.thaw)
	r.With(read).Get("/releases", a.listReleases)
	r.With(auth.Require("APPROVE_ROLLOUT")).Post("/releases/{releaseId}/approve", a.approve)
	r.With(auth.Require("APPROVE_ROLLOUT")).Post("/releases/{releaseId}/deny", a.deny)
}

func releaseJSON(r *model.FleetRelease) any {
	if r == nil {
		return nil
	}
	return map[string]any{
		"id": r.ID, "fleetId": r.FleetID, "fleet": r.FleetName, "distributionSetId": r.DSID, "distributionSet": r.DSLabel,
		"fromId": r.FromFleetID, "from": r.FromFleetName, "status": r.Status, "forced": r.Forced,
		"reason": r.Reason, "gateReport": r.GateReport, "requestedBy": r.RequestedBy, "requestedAt": r.RequestedAt,
		"decidedBy": r.DecidedBy, "decidedAt": r.DecidedAt, "startedAt": r.StartedAt, "finishedAt": r.FinishedAt,
		"waves": r.Waves, "lastWaveAt": r.LastWaveAt,
		"manifestId": r.ManifestID, "manifest": r.ManifestLabel, "systemDeploymentId": r.SystemDeploymentID,
	}
}

func fleetJSON(st service.FleetState) map[string]any {
	f := st.Fleet
	m := map[string]any{
		"id": f.ID, "name": f.Name, "description": f.Description, "colour": f.Colour, "rule": f.Rule,
		"distributionSetId": f.DSID, "distributionSet": f.DSLabel, "actionType": f.ActionType,
		"upstreamId": f.UpstreamID, "upstream": f.UpstreamName, "temporary": f.Temporary, "autoPromote": f.AutoPromote,
		"gate": map[string]any{"minDevices": f.Gate.MinDevices, "minSuccess": f.Gate.MinSuccess,
			"soakMinutes": f.Gate.SoakMinutes, "approvalRequired": f.Gate.ApprovalRequired},
		"wavePercent": f.WavePercent, "waveTimeoutMinutes": f.WaveTimeoutMinutes, "errorThreshold": f.ErrorThreshold,
		"freeze":  nil,
		"members": f.Members, "onRelease": f.OnRelease, "updating": f.Updating, "failed": f.Failed,
		"inSystems":  f.InSystems,
		"manifestId": f.ManifestID, "manifest": f.ManifestLabel, "systems": nil,
		"orchestrator": map[string]any{"maxParallel": f.Orchestrator.MaxParallel, "maxFailed": f.Orchestrator.MaxFailed,
			"byCentre": f.Orchestrator.ByCentre, "centres": f.Orchestrator.Centres},
		"release": releaseJSON(st.Release), "pending": releaseJSON(st.Pending), "progress": nil,
		"createdAt": f.CreatedAt, "createdBy": f.CreatedBy, "lastModifiedAt": f.LastModifiedAt,
		"lastModifiedBy": f.LastModifiedBy,
	}
	if f.FreezeReason != nil {
		m["freeze"] = map[string]any{"reason": *f.FreezeReason, "from": f.FreezeFrom, "until": f.FreezeUntil,
			"active": f.Frozen(httpx.Now())}
	}
	if o := st.Systems; o != nil {
		m["systems"] = map[string]any{"deploymentId": o.Deployment.ID, "name": o.Deployment.Name,
			"status": o.Deployment.Status, "reason": o.Deployment.Reason, "total": o.Total, "counts": o.Counts,
			"centre": o.Centre, "byCentre": o.Deployment.ByGroup}
	}
	if p := st.Progress; p != nil {
		m["progress"] = map[string]any{"members": p.Members, "onRelease": p.OnRelease, "active": p.Active,
			"succeeded": p.Succeeded, "failed": p.Failed}
	}
	return m
}

func fleetID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	return pathInt(w, r, "fleetId", "Fleet")
}

func (a *API) listFleets(w http.ResponseWriter, r *http.Request) {
	fs, err := a.st.Fleets(r.Context())
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(fs))
	for _, f := range fs {
		st, err := a.svc.FleetState(r.Context(), f)
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		out = append(out, fleetJSON(st))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

type gateBody struct {
	MinDevices       *int  `json:"minDevices"`
	MinSuccess       *int  `json:"minSuccess"`
	SoakMinutes      *int  `json:"soakMinutes"`
	ApprovalRequired *bool `json:"approvalRequired"`
}

type fleetBody struct {
	Name               *string   `json:"name"`
	Description        *string   `json:"description"`
	Colour             *string   `json:"colour"`
	Rule               *string   `json:"rule"`
	DistributionSetID  *int64    `json:"distributionSetId"`
	ActionType         *string   `json:"actionType"`
	UpstreamID         *int64    `json:"upstreamId"`
	Temporary          *bool     `json:"temporary"`
	AutoPromote        *bool     `json:"autoPromote"`
	Gate               *gateBody `json:"gate"`
	WavePercent        *int      `json:"wavePercent"`
	WaveTimeoutMinutes *int      `json:"waveTimeoutMinutes"`
	ErrorThreshold     *int      `json:"errorThreshold"`
	ManifestID         *int64    `json:"manifestId"`
	Orchestrator       *orchBody `json:"orchestrator"`
}

type orchBody struct {
	MaxParallel *int  `json:"maxParallel"`
	MaxFailed   *int  `json:"maxFailed"`
	ByCentre    *bool `json:"byCentre"`
	// the centres it takes, in that order; [] or absent: every centre, by name
	Centres *[]string `json:"centres"`
}

func setInt(dst *int, v *int) {
	if v != nil {
		*dst = *v
	}
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
	if b.ActionType != nil {
		f.ActionType = *b.ActionType
	}
	if b.UpstreamID != nil {
		if *b.UpstreamID == 0 {
			f.UpstreamID = nil // stands alone
		} else {
			f.UpstreamID = b.UpstreamID
		}
	}
	if b.Temporary != nil {
		f.Temporary = *b.Temporary
	}
	if b.AutoPromote != nil {
		f.AutoPromote = *b.AutoPromote
	}
	if g := b.Gate; g != nil {
		setInt(&f.Gate.MinDevices, g.MinDevices)
		setInt(&f.Gate.MinSuccess, g.MinSuccess)
		setInt(&f.Gate.SoakMinutes, g.SoakMinutes)
		if g.ApprovalRequired != nil {
			f.Gate.ApprovalRequired = *g.ApprovalRequired
		}
	}
	setInt(&f.WavePercent, b.WavePercent)
	setInt(&f.WaveTimeoutMinutes, b.WaveTimeoutMinutes)
	setInt(&f.ErrorThreshold, b.ErrorThreshold)
	if o := b.Orchestrator; o != nil {
		setInt(&f.Orchestrator.MaxParallel, o.MaxParallel)
		setInt(&f.Orchestrator.MaxFailed, o.MaxFailed)
		if o.ByCentre != nil {
			f.Orchestrator.ByCentre = *o.ByCentre
		}
		if o.Centres != nil {
			f.Orchestrator.Centres = *o.Centres
		}
	}
}

func (a *API) createFleet(w http.ResponseWriter, r *http.Request) {
	var b fleetBody
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	f := model.Fleet{Gate: model.Gate{MinDevices: 1, MinSuccess: 100}, WaveTimeoutMinutes: 60,
		Orchestrator: model.Orchestration{MaxParallel: 4, ByCentre: true}}
	b.apply(&f)
	var release, manifest *int64
	if b.DistributionSetID != nil && *b.DistributionSetID != 0 {
		release = b.DistributionSetID
		if b.ManifestID != nil && *b.ManifestID != 0 {
			manifest = b.ManifestID
		}
	}
	id, err := a.svc.SaveFleet(r.Context(), auth.User(r.Context()), f, release, manifest)
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
	st, err := a.svc.FleetState(r.Context(), f)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, status, fleetJSON(st))
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
	// only a change of release is a release: the same set again is not
	var release *int64
	if d := b.DistributionSetID; d != nil && !(f.DSID == nil && *d == 0) && !(f.DSID != nil && *f.DSID == *d) {
		release = d
	}
	// a change of manifest, with the same set, is a release too
	var manifest *int64
	if m := b.ManifestID; m != nil {
		if f.ManifestID == nil && *m == 0 || f.ManifestID != nil && *f.ManifestID == *m {
			m = nil
		}
		manifest = m
	}
	if _, err := a.svc.SaveFleet(r.Context(), auth.User(r.Context()), f, release, manifest); err != nil {
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
	ms, total, err := a.st.FleetMembers(r.Context(), id, p)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		out = append(out, map[string]any{
			"controllerId": m.ControllerID, "name": m.Name, "updateStatus": m.UpdateStatus,
			"installed": m.Installed, "assigned": m.Assigned, "lastControllerRequestAt": m.LastRequestAt,
			"joinedAt": m.JoinedAt, "home": m.Home,
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

// returnHome: {"controllerIds": [...]} or {} for every member.
func (a *API) returnHome(w http.ResponseWriter, r *http.Request) {
	id, found := fleetID(w, r)
	if !found {
		return
	}
	var b struct {
		ControllerIDs []string `json:"controllerIds"`
	}
	if r.ContentLength != 0 {
		if e := httpx.Decode(r, &b); e != nil {
			httpx.WriteError(w, e)
			return
		}
	}
	back, homeless, err := a.svc.ReturnHome(r.Context(), auth.User(r.Context()), id, b.ControllerIDs)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"returned": back, "stayed": homeless})
}

// gate: ?from=<fleet> -- would a promotion from there pass, and why.
func (a *API) gate(w http.ResponseWriter, r *http.Request) {
	id, found := fleetID(w, r)
	if !found {
		return
	}
	from, err := strconv.ParseInt(r.URL.Query().Get("from"), 10, 64)
	if err != nil {
		httpx.WriteError(w, httpx.Validation("say which fleet the release comes from: ?from=<id>"))
		return
	}
	report, open, err := a.svc.Gate(r.Context(), id, from)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"open": open, "report": report})
}

// promote: {"from": <fleet id>, "force": false, "reason": "..."}.
func (a *API) promote(w http.ResponseWriter, r *http.Request) {
	id, found := fleetID(w, r)
	if !found {
		return
	}
	var b struct {
		From         int64  `json:"from"`
		Force        bool   `json:"force"`
		Reason       string `json:"reason"`
		Orchestrator *bool  `json:"orchestrator"` // the release's manifest comes along (default: yes)
	}
	if e := httpx.Decode(r, &b); e != nil || b.From == 0 {
		httpx.WriteError(w, httpx.Validation("give the fleet to promote from: {\"from\": <id>}"))
		return
	}
	rel, err := a.svc.Promote(r.Context(), auth.User(r.Context()), auth.Can(r.Context(), "APPROVE_ROLLOUT"),
		id, b.From, b.Force, b.Reason, b.Orchestrator)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	status := http.StatusOK
	if rel.Status == model.ReleasePending {
		status = http.StatusAccepted
	}
	httpx.WriteJSON(w, status, releaseJSON(&rel))
}

func (a *API) sendReleases(w http.ResponseWriter, r *http.Request, fleet int64, status string) {
	limit := 100
	if l, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && l > 0 && l <= 500 {
		limit = l
	}
	rs, err := a.st.Releases(r.Context(), fleet, status, limit)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]any, 0, len(rs))
	for i := range rs {
		out = append(out, releaseJSON(&rs[i]))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

func (a *API) fleetReleases(w http.ResponseWriter, r *http.Request) {
	if id, found := fleetID(w, r); found {
		a.sendReleases(w, r, id, r.URL.Query().Get("status"))
	}
}

// listReleases: every fleet's; ?status=waiting_for_approval is the queue.
func (a *API) listReleases(w http.ResponseWriter, r *http.Request) {
	a.sendReleases(w, r, 0, r.URL.Query().Get("status"))
}

func (a *API) decide(w http.ResponseWriter, r *http.Request, approve bool) {
	id, ok := pathInt(w, r, "releaseId", "Release")
	if !ok {
		return
	}
	var b struct {
		Note string `json:"note"`
	}
	if r.ContentLength != 0 {
		if e := httpx.Decode(r, &b); e != nil {
			httpx.WriteError(w, e)
			return
		}
	}
	decide := a.svc.Deny
	if approve {
		decide = a.svc.Approve
	}
	rel, err := decide(r.Context(), auth.User(r.Context()), id, b.Note)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, releaseJSON(&rel))
}

func (a *API) approve(w http.ResponseWriter, r *http.Request) { a.decide(w, r, true) }
func (a *API) deny(w http.ResponseWriter, r *http.Request)    { a.decide(w, r, false) }

func (a *API) resume(w http.ResponseWriter, r *http.Request) {
	id, found := fleetID(w, r)
	if !found {
		return
	}
	if err := a.svc.Resume(r.Context(), auth.User(r.Context()), id); err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.sendFleet(w, r, id, http.StatusOK)
}

// freeze: {"reason": "...", "from": <ms>, "until": <ms>} -- from and until
// may be left out: now, and for ever.
func (a *API) freeze(w http.ResponseWriter, r *http.Request) {
	id, found := fleetID(w, r)
	if !found {
		return
	}
	var b struct {
		Reason string `json:"reason"`
		From   *int64 `json:"from"`
		Until  *int64 `json:"until"`
	}
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	if err := a.svc.Freeze(r.Context(), auth.User(r.Context()), id, b.Reason, b.From, b.Until); err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.sendFleet(w, r, id, http.StatusOK)
}

func (a *API) thaw(w http.ResponseWriter, r *http.Request) {
	id, found := fleetID(w, r)
	if !found {
		return
	}
	if err := a.svc.Thaw(r.Context(), auth.User(r.Context()), id); err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.sendFleet(w, r, id, http.StatusOK)
}
