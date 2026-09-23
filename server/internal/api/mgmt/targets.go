// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package mgmt

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/service"
	"qawk/internal/store"
	"qawk/internal/tenantcfg"
)

func (a *API) targetRoutes(r chi.Router) {
	need(r, "READ_TARGET").Get("/targets", a.listTargets)
	need(r, "CREATE_TARGET").Post("/targets", a.createTargets)
	need(r, "READ_TARGET").Get("/targets/{targetId}", a.getTarget)
	need(r, "UPDATE_TARGET").Put("/targets/{targetId}", a.updateTarget)
	need(r, "DELETE_TARGET").Delete("/targets/{targetId}", a.deleteTarget)
	need(r, "READ_TARGET").Get("/targets/{targetId}/attributes", a.targetAttributes)
	need(r, "READ_TARGET").Get("/targets/{targetId}/actions", a.targetActions)
	need(r, "UPDATE_TARGET").Delete("/targets/{targetId}/actions", a.deleteTargetActions)
	need(r, "READ_TARGET").Get("/targets/{targetId}/actions/{actionId}", a.targetAction)
	need(r, "UPDATE_TARGET").Delete("/targets/{targetId}/actions/{actionId}", a.cancelAction)
	need(r, "UPDATE_TARGET").Put("/targets/{targetId}/actions/{actionId}", a.updateAction)
	need(r, "UPDATE_TARGET").Put("/targets/{targetId}/actions/{actionId}/confirmation", a.confirmAction)
	need(r, "READ_TARGET").Get("/targets/{targetId}/actions/{actionId}/status", a.actionStatus)
	need(r, "READ_TARGET").Get("/targets/{targetId}/assignedDS", a.targetAssigned)
	need(r, "UPDATE_TARGET").Post("/targets/{targetId}/assignedDS", a.assignToTarget)
	need(r, "READ_TARGET").Get("/targets/{targetId}/installedDS", a.targetInstalled)
	need(r, "READ_TARGET").Get("/targets/{targetId}/tags", a.targetTags)
	need(r, "READ_TARGET").Get("/targets/{targetId}/autoConfirm", a.autoConfirm)
	need(r, "UPDATE_TARGET").Post("/targets/{targetId}/autoConfirm/activate", a.autoConfirmOn)
	need(r, "UPDATE_TARGET").Post("/targets/{targetId}/autoConfirm/deactivate", a.autoConfirmOff)
	need(r, "UPDATE_TARGET").Post("/targets/{targetId}/targettype", a.setTargetType)
	need(r, "UPDATE_TARGET").Delete("/targets/{targetId}/targettype", a.unsetTargetType)
	a.metadataRoutes(r, "/targets/{targetId}", store.MetaTarget, "READ_TARGET", "UPDATE_TARGET", a.targetOwner)

	need(r, "READ_TARGET").Get("/targetgroups", a.groupNames)
	need(r, "READ_TARGET").Get("/targetgroups/assigned", a.groupTargets)
	need(r, "READ_TARGET").Get("/targetgroups/{group}/assigned", a.groupTargets)
	need(r, "UPDATE_TARGET").Put("/targetgroups", a.groupByQuery)
	need(r, "UPDATE_TARGET").Put("/targetgroups/{group}", a.groupByQuery)
	need(r, "UPDATE_TARGET").Put("/targetgroups/assigned", a.groupByIDs)
	need(r, "UPDATE_TARGET").Put("/targetgroups/{group}/assigned", a.groupByIDs)
	need(r, "UPDATE_TARGET").Delete("/targetgroups", a.ungroupByQuery)
	need(r, "UPDATE_TARGET").Delete("/targetgroups/assigned", a.ungroupByIDs)
}

// pollInfo is what a target's pollStatus is computed from.
func (a *API) pollInfo(r *http.Request) pollInfo {
	ctx := r.Context()
	return pollInfo{now: httpx.Now(),
		interval: tenantcfg.Seconds(a.st.ConfigString(ctx, "pollingTime")) * 1000,
		overdue:  tenantcfg.Seconds(a.st.ConfigString(ctx, "pollingOverdueTime")) * 1000}
}

func (a *API) targetOf(w http.ResponseWriter, r *http.Request) (model.Target, bool) {
	t, err := a.st.Target(r.Context(), a.st.DB(), chi.URLParam(r, "targetId"))
	if err != nil {
		fail(w, err)
		return t, false
	}
	return t, true
}

func (a *API) targetOwner(w http.ResponseWriter, r *http.Request) (int64, bool) {
	t, found := a.targetOf(w, r)
	return t.ID, found
}

func (a *API) sendTargets(w http.ResponseWriter, r *http.Request, extra func(*store.Args) []string) {
	p, good := pageOf(w, r)
	if !good {
		return
	}
	ts, total, err := a.st.Targets(r.Context(), p, extra)
	if err != nil {
		fail(w, err)
		return
	}
	b, pi := a.base(r), a.pollInfo(r)
	out := make([]map[string]any, 0, len(ts))
	for _, t := range ts {
		out = append(out, targetJSON(b, t, false, pi))
	}
	sendList(w, out, total)
}

func (a *API) listTargets(w http.ResponseWriter, r *http.Request) { a.sendTargets(w, r, nil) }

type targetBody struct {
	ControllerID      *string `json:"controllerId"`
	Name              *string `json:"name"`
	Description       *string `json:"description"`
	Address           *string `json:"address"`
	SecurityToken     *string `json:"securityToken"`
	RequestAttributes *bool   `json:"requestAttributes"`
	TargetType        *int64  `json:"targetType"`
	Group             *string `json:"group"`
}

func newToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (a *API) createTargets(w http.ResponseWriter, r *http.Request) {
	var body []targetBody
	if !decode(w, r, &body) {
		return
	}
	var ids []int64
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		for _, b := range body {
			cid := strings.TrimSpace(str(b.ControllerID))
			if cid == "" {
				return httpx.Validation("controllerId must not be empty")
			}
			t := model.Target{ControllerID: cid, Name: cid, UpdateStatus: model.UpdateRegistered,
				RequestAttributes: true, SecurityToken: newToken(), Address: b.Address, Group: b.Group}
			if b.Name != nil && *b.Name != "" {
				t.Name = *b.Name
			}
			t.Description = str(b.Description)
			if b.SecurityToken != nil && *b.SecurityToken != "" {
				t.SecurityToken = *b.SecurityToken
			}
			if b.TargetType != nil {
				if _, err := a.st.TargetType(r.Context(), tx, *b.TargetType); err != nil {
					return err
				}
				t.TypeID = b.TargetType
			}
			id, err := a.st.CreateTarget(r.Context(), tx, user(r), now, t)
			if err != nil {
				return err
			}
			ids = append(ids, id)
		}
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	b, pi := a.base(r), a.pollInfo(r)
	out := []map[string]any{}
	for _, id := range ids {
		if t, err := a.st.TargetByID(r.Context(), a.st.DB(), id); err == nil {
			out = append(out, targetJSON(b, t, false, pi))
		}
	}
	sendCreated(w, out)
}

func (a *API) getTarget(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetOf(w, r)
	if !found {
		return
	}
	sendOK(w, targetJSON(a.base(r), t, true, a.pollInfo(r)))
}

func (a *API) updateTarget(w http.ResponseWriter, r *http.Request) {
	var b targetBody
	if !decode(w, r, &b) {
		return
	}
	var t model.Target
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		var err error
		t, err = a.st.TargetForUpdate(r.Context(), tx, chi.URLParam(r, "targetId"))
		if err != nil {
			return err
		}
		if b.Name != nil {
			t.Name = *b.Name
		}
		if b.Description != nil {
			t.Description = *b.Description
		}
		if b.Address != nil {
			t.Address = b.Address
		}
		if b.SecurityToken != nil {
			t.SecurityToken = *b.SecurityToken
		}
		if b.RequestAttributes != nil {
			t.RequestAttributes = *b.RequestAttributes
		}
		if b.Group != nil {
			t.Group = b.Group
		}
		if b.TargetType != nil {
			if _, err := a.st.TargetType(r.Context(), tx, *b.TargetType); err != nil {
				return err
			}
			t.TypeID = b.TargetType
		}
		if err := a.st.UpdateTarget(r.Context(), tx, user(r), now, t); err != nil {
			return err
		}
		t, err = a.st.TargetByID(r.Context(), tx, t.ID)
		return err
	})
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, targetJSON(a.base(r), t, true, a.pollInfo(r)))
}

func (a *API) deleteTarget(w http.ResponseWriter, r *http.Request) {
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		t, err := a.st.TargetForUpdate(r.Context(), tx, chi.URLParam(r, "targetId"))
		if err != nil {
			return err
		}
		return a.st.DeleteTarget(r.Context(), tx, t.ID)
	})
	if err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) targetAttributes(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetOf(w, r)
	if !found {
		return
	}
	attrs, err := a.st.Attributes(r.Context(), a.st.DB(), t.ID)
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, attrs)
}

// ------------------------------------------------------------------ actions

func (a *API) sendActions(w http.ResponseWriter, r *http.Request, extra func(*store.Args) []string) {
	p, good := pageOf(w, r)
	if !good {
		return
	}
	acts, total, err := a.st.Actions(r.Context(), p, extra)
	if err != nil {
		fail(w, err)
		return
	}
	b := a.base(r)
	out := make([]map[string]any, 0, len(acts))
	for _, act := range acts {
		out = append(out, actionJSON(b, act, false))
	}
	sendList(w, out, total)
}

func (a *API) targetActions(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetOf(w, r)
	if !found {
		return
	}
	a.sendActions(w, r, func(x *store.Args) []string { return []string{"a.target_id = " + x.Bind(t.ID)} })
}

// deleteTargetActions: ?keepLast=N deletes every closed action but the
// newest N, ?actionIds=1,2 the ones named.
func (a *API) deleteTargetActions(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetOf(w, r)
	if !found {
		return
	}
	var ids []int64
	if v := r.URL.Query().Get("actionIds"); v != "" {
		for _, s := range strings.Split(v, ",") {
			n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
			if err != nil {
				fail(w, httpx.Validation("actionIds must be numbers"))
				return
			}
			act, err := a.st.ActionOf(r.Context(), a.st.DB(), t.ID, n)
			if err != nil {
				fail(w, err)
				return
			}
			ids = append(ids, act.ID)
		}
	} else if v := r.URL.Query().Get("keepLast"); v != "" {
		keep, err := strconv.Atoi(v)
		if err != nil || keep < 0 {
			fail(w, httpx.Validation("keepLast must be a non-negative number"))
			return
		}
		all, _, err := a.st.Actions(r.Context(), httpx.Page{Limit: 1 << 30, Sort: []httpx.SortKey{{Field: "id", Desc: true}}},
			func(x *store.Args) []string { return []string{"a.target_id = " + x.Bind(t.ID)} })
		if err != nil {
			fail(w, err)
			return
		}
		for i, act := range all {
			if i >= keep && !act.Active {
				ids = append(ids, act.ID)
			}
		}
	} else {
		fail(w, httpx.Validation("give keepLast or actionIds"))
		return
	}
	if err := a.svc.DeleteActions(r.Context(), user(r), ids); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) actionOf(w http.ResponseWriter, r *http.Request) (model.Target, model.Action, bool) {
	t, found := a.targetOf(w, r)
	if !found {
		return t, model.Action{}, false
	}
	aid, found := pathID(w, r, "actionId", "Action")
	if !found {
		return t, model.Action{}, false
	}
	act, err := a.st.ActionOf(r.Context(), a.st.DB(), t.ID, aid)
	if err != nil {
		fail(w, err)
		return t, act, false
	}
	return t, act, true
}

func (a *API) targetAction(w http.ResponseWriter, r *http.Request) {
	_, act, found := a.actionOf(w, r)
	if !found {
		return
	}
	sendOK(w, actionJSON(a.base(r), act, true))
}

func (a *API) cancelAction(w http.ResponseWriter, r *http.Request) {
	t, act, found := a.actionOf(w, r)
	if !found {
		return
	}
	if err := a.svc.CancelAction(r.Context(), user(r), t.ControllerID, act.ID, r.URL.Query().Get("force") == "true"); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) updateAction(w http.ResponseWriter, r *http.Request) {
	t, act, found := a.actionOf(w, r)
	if !found {
		return
	}
	var body struct {
		ForceType string `json:"forceType"`
	}
	if !decode(w, r, &body) {
		return
	}
	if !strings.EqualFold(body.ForceType, model.TypeForced) {
		fail(w, httpx.Validation("an action can only be switched to forced"))
		return
	}
	updated, err := a.svc.SwitchToForced(r.Context(), user(r), t.ControllerID, act.ID)
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, actionJSON(a.base(r), updated, true))
}

func (a *API) confirmAction(w http.ResponseWriter, r *http.Request) {
	t, act, found := a.actionOf(w, r)
	if !found {
		return
	}
	var body struct {
		Confirmation string   `json:"confirmation"`
		Code         *int     `json:"code"`
		Details      []string `json:"details"`
	}
	if !decode(w, r, &body) {
		return
	}
	var confirmed bool
	switch strings.ToLower(body.Confirmation) {
	case "confirmed":
		confirmed = true
	case "denied":
	default:
		fail(w, httpx.Validation("confirmation must be confirmed or denied"))
		return
	}
	err := a.svc.Confirm(r.Context(), t, act.ID, confirmed, body.Code, body.Details)
	if errors.Is(err, service.ErrGone) {
		fail(w, httpx.Custom(400, "hawkbit.server.error.action.notwaitingforconfirmation",
			"org.eclipse.hawkbit.repository.exception.InvalidConfirmationFeedbackException",
			fmt.Sprintf("Action %d is not waiting for confirmation", act.ID)))
		return
	}
	if err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) actionStatus(w http.ResponseWriter, r *http.Request) {
	_, act, found := a.actionOf(w, r)
	if !found {
		return
	}
	p, good := pageOf(w, r)
	if !good {
		return
	}
	sts, total, err := a.st.Statuses(r.Context(), act.ID, p)
	if err != nil {
		fail(w, err)
		return
	}
	out := make([]map[string]any, 0, len(sts))
	for _, s := range sts {
		out = append(out, statusJSON(s))
	}
	sendList(w, out, total)
}

// ---------------------------------------------------------------- assignment

func (a *API) sendSetOrNothing(w http.ResponseWriter, r *http.Request, id *int64) {
	if id == nil {
		noContent(w)
		return
	}
	ds, err := a.st.DistributionSet(r.Context(), a.st.DB(), *id)
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, dsJSON(a.base(r), ds, true))
}

func (a *API) targetAssigned(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetOf(w, r)
	if found {
		a.sendSetOrNothing(w, r, t.AssignedDSID)
	}
}

func (a *API) targetInstalled(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetOf(w, r)
	if found {
		a.sendSetOrNothing(w, r, t.InstalledDSID)
	}
}

// assignBody is one assignment, as both /targets/{id}/assignedDS and
// /distributionsets/{id}/assignedTargets take it.
type assignBody struct {
	ID                   json_raw `json:"id"`
	Type                 string   `json:"type"`
	ForceTime            int64    `json:"forcetime"`
	Weight               *int     `json:"weight"`
	ConfirmationRequired *bool    `json:"confirmationRequired"`
	MaintenanceWindow    *struct {
		Schedule string `json:"schedule"`
		Duration string `json:"duration"`
		Timezone string `json:"timezone"`
	} `json:"maintenanceWindow"`
}

func (b assignBody) request(controllerID string) service.AssignRequest {
	req := service.AssignRequest{ControllerID: controllerID, Type: strings.ToLower(b.Type), ForceTime: b.ForceTime,
		Weight: b.Weight, ConfirmationRequired: b.ConfirmationRequired}
	if mw := b.MaintenanceWindow; mw != nil && mw.Schedule != "" {
		req.MaintenanceSchedule, req.MaintenanceDuration, req.MaintenanceTimezone = &mw.Schedule, &mw.Duration, &mw.Timezone
	}
	return req
}

func assignmentJSON(b string, res service.AssignResult) J {
	acts := make([]J, 0, len(res.ActionIDs))
	for i, id := range res.ActionIDs {
		acts = append(acts, J{"id": id, "_links": J{"self": link(fmt.Sprintf("%s/targets/%s/actions/%d", b, res.ControllerIDs[i], id))}})
	}
	return J{"assigned": res.Assigned, "alreadyAssigned": res.AlreadyAssigned, "total": res.Assigned + res.AlreadyAssigned,
		"assignedActions": acts}
}

func (a *API) assignToTarget(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetOf(w, r)
	if !found {
		return
	}
	var body assignBody
	if !decode(w, r, &body) {
		return
	}
	dsID, err := body.ID.Int()
	if err != nil {
		fail(w, httpx.NotReadable())
		return
	}
	res, err := a.svc.Assign(r.Context(), user(r), dsID, []service.AssignRequest{body.request(t.ControllerID)})
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, assignmentJSON(a.base(r), res))
}

// ------------------------------------------------------------ tags and types

func (a *API) targetTags(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetOf(w, r)
	if !found {
		return
	}
	tags, err := a.st.TagsOf(r.Context(), a.st.DB(), store.TagTarget, t.ID)
	if err != nil {
		fail(w, err)
		return
	}
	b := a.base(r)
	out := make([]J, 0, len(tags))
	for _, tg := range tags {
		out = append(out, tagJSON(b, store.TagTarget, tg, false))
	}
	sendOK(w, out)
}

func (a *API) autoConfirm(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetOf(w, r)
	if !found {
		return
	}
	self := a.base(r) + "/targets/" + t.ControllerID + "/autoConfirm"
	m := J{"active": t.AutoConfirmActive}
	if t.AutoConfirmActive {
		if t.AutoConfirmInitiator != nil {
			m["initiator"] = *t.AutoConfirmInitiator
		}
		if t.AutoConfirmRemark != nil {
			m["remark"] = *t.AutoConfirmRemark
		}
		if t.AutoConfirmAt != nil {
			m["activatedAt"] = *t.AutoConfirmAt
		}
		m["_links"] = J{"deactivate": link(self + "/deactivate")}
	} else {
		m["_links"] = J{"activate": link(self + "/activate")}
	}
	sendOK(w, m)
}

func (a *API) autoConfirmOn(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Initiator *string `json:"initiator"`
		Remark    *string `json:"remark"`
	}
	_ = httpx.Decode(r, &body) // optional
	if err := a.svc.SetAutoConfirm(r.Context(), user(r), chi.URLParam(r, "targetId"), true, body.Initiator, body.Remark); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) autoConfirmOff(w http.ResponseWriter, r *http.Request) {
	if err := a.svc.SetAutoConfirm(r.Context(), user(r), chi.URLParam(r, "targetId"), false, nil, nil); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) setTargetType(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID int64 `json:"id"`
	}
	if !decode(w, r, &body) {
		return
	}
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		t, err := a.st.TargetForUpdate(r.Context(), tx, chi.URLParam(r, "targetId"))
		if err != nil {
			return err
		}
		if _, err := a.st.TargetType(r.Context(), tx, body.ID); err != nil {
			return err
		}
		t.TypeID = &body.ID
		return a.st.UpdateTarget(r.Context(), tx, user(r), now, t)
	})
	if err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) unsetTargetType(w http.ResponseWriter, r *http.Request) {
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		t, err := a.st.TargetForUpdate(r.Context(), tx, chi.URLParam(r, "targetId"))
		if err != nil {
			return err
		}
		t.TypeID = nil
		return a.st.UpdateTarget(r.Context(), tx, user(r), now, t)
	})
	if err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

// ---------------------------------------------------------------- groups

func groupParam(r *http.Request) string {
	if g := chi.URLParam(r, "group"); g != "" {
		return g
	}
	return r.URL.Query().Get("group")
}

func (a *API) groupNames(w http.ResponseWriter, r *http.Request) {
	names, err := a.st.GroupNames(r.Context())
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, names)
}

func (a *API) groupTargets(w http.ResponseWriter, r *http.Request) {
	g := groupParam(r)
	if g == "" {
		fail(w, httpx.Validation("group is required"))
		return
	}
	a.sendTargets(w, r, store.InGroupOf(g, r.URL.Query().Get("subgroups") == "true"))
}

func (a *API) setGroup(w http.ResponseWriter, r *http.Request, ids []int64, group *string) {
	if err := a.tx(r, func(tx pgx.Tx, now int64) error {
		return a.st.SetGroup(r.Context(), tx, ids, group, user(r), now)
	}); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) matching(w http.ResponseWriter, r *http.Request) ([]int64, bool) {
	q := r.URL.Query().Get("q")
	if strings.TrimSpace(q) == "" {
		fail(w, httpx.Validation("q is required"))
		return nil, false
	}
	ids, err := a.st.Matching(r.Context(), a.st.DB(), q, nil)
	if err != nil {
		fail(w, err)
		return nil, false
	}
	return ids, true
}

func (a *API) controllerIDs(w http.ResponseWriter, r *http.Request) ([]int64, bool) {
	var body []string
	if !decode(w, r, &body) {
		return nil, false
	}
	ids, err := a.st.IDsOf(r.Context(), a.st.DB(), body)
	if err != nil {
		fail(w, err)
		return nil, false
	}
	return ids, true
}

func (a *API) groupByQuery(w http.ResponseWriter, r *http.Request) {
	g := groupParam(r)
	if g == "" {
		fail(w, httpx.Validation("group is required"))
		return
	}
	if ids, found := a.matching(w, r); found {
		a.setGroup(w, r, ids, &g)
	}
}

func (a *API) groupByIDs(w http.ResponseWriter, r *http.Request) {
	g := groupParam(r)
	if g == "" {
		fail(w, httpx.Validation("group is required"))
		return
	}
	if ids, found := a.controllerIDs(w, r); found {
		a.setGroup(w, r, ids, &g)
	}
}

func (a *API) ungroupByQuery(w http.ResponseWriter, r *http.Request) {
	if ids, found := a.matching(w, r); found {
		a.setGroup(w, r, ids, nil)
	}
}

func (a *API) ungroupByIDs(w http.ResponseWriter, r *http.Request) {
	if ids, found := a.controllerIDs(w, r); found {
		a.setGroup(w, r, ids, nil)
	}
}
