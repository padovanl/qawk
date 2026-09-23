// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package mgmt

import (
	"fmt"
	"strings"

	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/service"
	"qawk/internal/store"
	"qawk/internal/tenantcfg"
)

// The Management API's JSON, entity by entity, matching the recorded
// samples: an object in a list carries only its "self" link, the same object
// on its own carries all of them; a field hawkBit leaves out when it has no
// value (description, installedAt, ...) is left out here too.

type J = map[string]any

func link(href string) httpx.Link { return httpx.L(href) }

func named(href, name string) httpx.Link { return httpx.Link{Href: href, Name: name} }

func audit(m J, a model.Audit) J {
	m["createdAt"] = a.CreatedAt
	m["createdBy"] = a.CreatedBy
	m["lastModifiedAt"] = a.LastModifiedAt
	m["lastModifiedBy"] = a.LastModifiedBy
	return m
}

func optional(m J, key string, v string) {
	if v != "" {
		m[key] = v
	}
}

// ------------------------------------------------------------------ targets

// pollInfo is what a target's pollStatus is computed from.
type pollInfo struct {
	now      int64
	interval int64 // ms
	overdue  int64 // ms
}

func targetJSON(b string, t model.Target, full bool, p pollInfo) J {
	self := b + "/targets/" + t.ControllerID
	m := J{
		"controllerId":      t.ControllerID,
		"name":              t.Name,
		"updateStatus":      t.UpdateStatus,
		"securityToken":     t.SecurityToken,
		"requestAttributes": t.RequestAttributes,
	}
	optional(m, "description", t.Description)
	if t.Address != nil && *t.Address != "" {
		m["address"] = *t.Address
		ip := *t.Address
		if i := strings.Index(ip, "://"); i >= 0 {
			ip = ip[i+3:]
		}
		m["ipAddress"] = ip
	}
	if t.InstalledAt != nil {
		m["installedAt"] = *t.InstalledAt
	}
	if t.LastRequestAt != nil {
		m["lastControllerRequestAt"] = *t.LastRequestAt
		next := *t.LastRequestAt + p.interval
		m["pollStatus"] = J{
			"lastRequestAt":         *t.LastRequestAt,
			"nextExpectedRequestAt": next,
			"overdue":               p.now > next+p.overdue,
		}
	}
	if t.TypeID != nil {
		m["targetType"] = *t.TypeID
		if t.TypeName != nil {
			m["targetTypeName"] = *t.TypeName
		}
	}
	if t.AutoConfirmActive {
		m["autoConfirmActive"] = true
	}
	audit(m, t.Audit)
	links := J{"self": link(self)}
	if full {
		links["assignedDS"] = link(self + "/assignedDS")
		links["installedDS"] = link(self + "/installedDS")
		links["attributes"] = link(self + "/attributes")
		links["actions"] = link(self + "/actions?offset=0&limit=50&sort=id%3ADESC")
		links["metadata"] = link(self + "/metadata")
		if t.TypeID != nil {
			links["targetType"] = link(fmt.Sprintf("%s/targettypes/%d", b, *t.TypeID))
		}
		links["autoConfirm"] = link(self + "/autoConfirm")
	}
	m["_links"] = links
	return m
}

// ------------------------------------------------------------------ actions

func actionType(a model.Action) string {
	if a.Status == model.StatusCanceling || a.Status == model.StatusCanceled {
		return "cancel"
	}
	return "update"
}

func actionJSON(b string, act model.Action, full bool) J {
	self := fmt.Sprintf("%s/targets/%s/actions/%d", b, act.ControllerID, act.ID)
	m := J{
		"id":        act.ID,
		"active":    act.Active,
		"status":    act.Status,
		"type":      actionType(act),
		"forceType": act.ActionType,
		"weight":    1000,
	}
	if act.Weight != nil {
		m["weight"] = *act.Weight
	}
	if act.ActionType == model.TypeTimeForced {
		m["forceTime"] = act.ForcedTime
	}
	if act.RolloutID != nil {
		m["rollout"] = *act.RolloutID
		if act.RolloutName != nil {
			m["rolloutName"] = *act.RolloutName
		}
	}
	if act.LastStatusCode != nil {
		m["lastStatusCode"] = *act.LastStatusCode
	}
	if act.ExternalRef != nil {
		m["externalRef"] = *act.ExternalRef
	}
	if act.MaintenanceSchedule != nil {
		m["maintenanceWindow"] = J{"schedule": str(act.MaintenanceSchedule), "duration": str(act.MaintenanceDuration),
			"timezone": str(act.MaintenanceTimezone)}
		if next, ok := service.NextMaintenance(act, httpx.Now()); ok {
			m["maintenanceWindow"].(J)["nextStartAt"] = next
		}
	}
	audit(m, act.Audit)
	links := J{"self": link(self)}
	if full {
		links["target"] = named(b+"/targets/"+act.ControllerID, act.ControllerID)
		links["distributionset"] = named(fmt.Sprintf("%s/distributionsets/%d", b, act.DSID), act.DSLabel)
		links["status"] = link(self + "/status?offset=0&limit=50&sort=id%3ADESC")
		if act.RolloutID != nil {
			links["rollout"] = named(fmt.Sprintf("%s/rollouts/%d", b, *act.RolloutID), str(act.RolloutName))
		}
		if act.RolloutGroupID != nil && act.RolloutID != nil {
			links["rolloutgroup"] = named(fmt.Sprintf("%s/rollouts/%d/deploygroups/%d", b, *act.RolloutID, *act.RolloutGroupID),
				str(act.RolloutGroupName))
		}
	}
	m["_links"] = links
	return m
}

func statusJSON(s model.ActionStatus) J {
	m := J{"id": s.ID, "type": s.Status, "messages": s.Messages, "reportedAt": s.ReportedAt, "timestamp": s.OccurredAt}
	if m["messages"] == nil {
		m["messages"] = []string{}
	}
	if s.Code != nil {
		m["code"] = *s.Code
	}
	return m
}

// ----------------------------------------------------------------- software

func smJSON(b string, s model.SoftwareModule, full bool) J {
	self := fmt.Sprintf("%s/softwaremodules/%d", b, s.ID)
	m := J{
		"id": s.ID, "name": s.Name, "version": s.Version, "type": s.TypeKey, "typeName": s.TypeName,
		"vendor": s.Vendor, "deleted": s.Deleted, "encrypted": s.Encrypted, "locked": s.Locked, "complete": s.Complete,
	}
	optional(m, "description", s.Description)
	audit(m, s.Audit)
	links := J{"self": link(self)}
	if full {
		links["artifacts"] = link(self + "/artifacts")
		links["type"] = link(fmt.Sprintf("%s/softwaremoduletypes/%d", b, s.TypeID))
		links["metadata"] = link(self + "/metadata")
	}
	m["_links"] = links
	return m
}

func artifactJSON(b string, art model.Artifact, full bool) J {
	self := fmt.Sprintf("%s/softwaremodules/%d/artifacts/%d", b, art.SMID, art.ID)
	m := J{
		"id": art.ID, "providedFilename": art.Filename, "size": art.Size,
		"hashes": J{"sha1": art.SHA1, "md5": art.MD5, "sha256": art.SHA256},
	}
	audit(m, art.Audit)
	links := J{"self": link(self)}
	if full {
		links["download"] = link(self + "/download")
	}
	m["_links"] = links
	return m
}

func dsJSON(b string, d model.DistributionSet, full bool) J {
	self := fmt.Sprintf("%s/distributionsets/%d", b, d.ID)
	mods := make([]J, 0, len(d.Modules))
	for _, s := range d.Modules {
		mods = append(mods, smJSON(b, s, false))
	}
	m := J{
		"id": d.ID, "name": d.Name, "version": d.Version, "type": d.TypeKey, "typeName": d.TypeName,
		"complete": d.Complete, "valid": d.Valid, "locked": d.Locked, "deleted": d.Deleted,
		"requiredMigrationStep": d.RequiredMigrationStep, "modules": mods,
	}
	optional(m, "description", d.Description)
	audit(m, d.Audit)
	links := J{"self": link(self)}
	if full {
		links["modules"] = link(self + "/assignedSM?offset=0&limit=50")
		links["type"] = link(fmt.Sprintf("%s/distributionsettypes/%d", b, d.TypeID))
		links["metadata"] = link(self + "/metadata")
	}
	m["_links"] = links
	return m
}

// -------------------------------------------------------------------- types

func colour(m J, c *string) {
	if c != nil && *c != "" {
		m["colour"] = *c
	}
}

func smTypeJSON(b string, t model.SMType) J {
	m := J{"id": t.ID, "key": t.Key, "name": t.Name, "description": t.Description, "deleted": t.Deleted,
		"maxAssignments": t.MaxAssignments, "minArtifacts": t.MinArtifacts}
	colour(m, t.Colour)
	audit(m, t.Audit)
	m["_links"] = J{"self": link(fmt.Sprintf("%s/softwaremoduletypes/%d", b, t.ID))}
	return m
}

func dsTypeJSON(b string, t model.DSType, full bool) J {
	self := fmt.Sprintf("%s/distributionsettypes/%d", b, t.ID)
	m := J{"id": t.ID, "key": t.Key, "name": t.Name, "description": t.Description, "deleted": t.Deleted}
	colour(m, t.Colour)
	audit(m, t.Audit)
	links := J{"self": link(self)}
	if full {
		links["mandatorymodules"] = link(self + "/mandatorymoduletypes")
		links["optionalmodules"] = link(self + "/optionalmoduletypes")
	}
	m["_links"] = links
	return m
}

func targetTypeJSON(b string, t model.TargetType, full bool) J {
	self := fmt.Sprintf("%s/targettypes/%d", b, t.ID)
	m := J{"id": t.ID, "key": t.Key, "name": t.Name, "description": t.Description, "deleted": false}
	colour(m, t.Colour)
	audit(m, t.Audit)
	links := J{"self": link(self)}
	if full {
		links["compatibledistributionsettypes"] = link(self + "/compatibledistributionsettypes")
	}
	m["_links"] = links
	return m
}

// --------------------------------------------------------------------- tags

func tagJSON(b string, kind store.TagKind, t model.Tag, full bool) J {
	coll, members := "targettags", "assignedTargets"
	if kind == store.TagDS {
		coll, members = "distributionsettags", "assignedDistributionSets"
	}
	self := fmt.Sprintf("%s/%s/%d", b, coll, t.ID)
	m := J{"id": t.ID, "name": t.Name, "description": t.Description}
	colour(m, t.Colour)
	audit(m, t.Audit)
	links := J{"self": link(self)}
	if full {
		links[members] = link(self + "/assigned?offset=0&limit=50")
	}
	m["_links"] = links
	return m
}

// ------------------------------------------------------------------ filters

// filterJSON: unlike the other entities, hawkBit writes the auto-assignment
// fields as explicit nulls when they are not set.
func filterJSON(b string, f model.TargetFilter, full bool) J {
	self := fmt.Sprintf("%s/targetfilters/%d", b, f.ID)
	m := J{"id": f.ID, "name": f.Name, "query": f.Query, "autoAssignDistributionSet": nil,
		"autoAssignActionType": nil, "autoAssignWeight": nil, "confirmationRequired": nil}
	if f.AutoAssignDSID != nil {
		m["autoAssignDistributionSet"] = *f.AutoAssignDSID
	}
	if f.AutoAssignActionType != nil {
		m["autoAssignActionType"] = *f.AutoAssignActionType
	}
	if f.AutoAssignWeight != nil {
		m["autoAssignWeight"] = *f.AutoAssignWeight
	}
	if f.ConfirmationRequired != nil {
		m["confirmationRequired"] = *f.ConfirmationRequired
	}
	audit(m, f.Audit)
	links := J{"self": link(self)}
	if full {
		links["autoAssignDS"] = link(self + "/autoAssignDS")
	}
	m["_links"] = links
	return m
}

// ----------------------------------------------------------------- rollouts

func rolloutJSON(b string, o model.Rollout, groups int, counts map[string]int64, full bool) J {
	self := fmt.Sprintf("%s/rollouts/%d", b, o.ID)
	m := J{
		"id": o.ID, "name": o.Name, "status": o.Status, "distributionSetId": o.DSID,
		"targetFilterQuery": o.TargetFilterQuery, "type": o.ActionType, "forcetime": o.ForcedTime,
		"totalTargets": o.TotalTargets, "totalGroups": groups, "dynamic": o.Dynamic, "deleted": o.Deleted,
		"weight": 1000,
	}
	if o.Weight != nil {
		m["weight"] = *o.Weight
	}
	optional(m, "description", o.Description)
	if o.StartAt != nil {
		m["startAt"] = *o.StartAt
	}
	if o.ApprovalDecidedBy != nil {
		m["approveDecidedBy"] = *o.ApprovalDecidedBy
	}
	if o.ApprovalRemark != nil {
		m["approvalRemark"] = *o.ApprovalRemark
	}
	if o.ConfirmationRequired != nil {
		m["confirmationRequired"] = *o.ConfirmationRequired
	}
	if counts != nil {
		m["totalTargetsPerStatus"] = counts
	}
	audit(m, o.Audit)
	links := J{"self": link(self)}
	if full {
		for _, c := range []string{"start", "pause", "resume", "triggerNextGroup", "approve", "deny"} {
			links[c] = link(self + "/" + c)
		}
		links["groups"] = link(self + "/deploygroups?offset=0&limit=50")
		links["distributionset"] = named(fmt.Sprintf("%s/distributionsets/%d", b, o.DSID), o.DSLabel)
	}
	m["_links"] = links
	return m
}

func conditionJSON(c model.Condition, key string) J {
	return J{key: c.Condition, "expression": c.Expression}
}

func groupJSON(b string, g model.RolloutGroup, counts map[string]int64) J {
	m := J{
		"id": g.ID, "name": g.Name, "description": g.Description, "status": g.Status,
		"targetFilterQuery": g.TargetFilterQuery, "targetPercentage": g.TargetPercentage,
		"totalTargets": g.TotalTargets, "dynamic": g.Dynamic,
		"successCondition": conditionJSON(g.SuccessCondition, "condition"),
		"successAction":    conditionJSON(g.SuccessAction, "action"),
	}
	if g.ErrorCondition != nil {
		m["errorCondition"] = conditionJSON(*g.ErrorCondition, "condition")
	}
	if g.ErrorAction != nil {
		m["errorAction"] = conditionJSON(*g.ErrorAction, "action")
	}
	if g.ConfirmationRequired != nil {
		m["confirmationRequired"] = *g.ConfirmationRequired
	}
	if counts != nil {
		m["totalTargetsPerStatus"] = counts
	}
	audit(m, g.Audit)
	m["_links"] = J{"self": link(fmt.Sprintf("%s/rollouts/%d/deploygroups/%d", b, g.RolloutID, g.ID))}
	return m
}

// ----------------------------------------------------------------- metadata

func metaJSON(m model.Metadata, visible bool) J {
	j := J{"key": m.Key, "value": m.Value}
	if visible {
		j["targetVisible"] = m.TargetVisible
	}
	return j
}

// ------------------------------------------------------------------ configs

func configJSON(b, key string, v store.ConfigValue) J {
	m := J{"value": v.Value, "global": v.Global,
		"links": []J{{"rel": "self", "href": b + "/system/configs/" + key}}}
	if v.Audit != nil {
		audit(m, *v.Audit)
	}
	return m
}

// configKnown says whether a key is one this server has.
func configKnown(key string) bool {
	_, ok := tenantcfg.Lookup(key)
	return ok
}
