// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package store

import "qawk/internal/fiql"

// The queryable and sortable fields of every entity, with the names hawkBit
// uses (lower case: names are matched case-insensitively) and the SQL each one
// maps to. The aliases (t, d, m, ...) are the ones the list queries use.
//
// The console's editor offers exactly these names for targets, sets, modules
// and rollouts (console/js/fiql.js), and test/fiql-live.mjs checks, name by
// name and value by value, that the server agrees with it.

func audit(f map[string]fiql.Field, alias string) map[string]fiql.Field {
	f["createdat"] = fiql.Field{Column: alias + ".created_at", Kind: fiql.Number}
	f["createdby"] = fiql.Field{Column: alias + ".created_by"}
	f["lastmodifiedat"] = fiql.Field{Column: alias + ".last_modified_at", Kind: fiql.Number}
	f["lastmodifiedby"] = fiql.Field{Column: alias + ".last_modified_by"}
	return f
}

var targetFields = &fiql.Fields{
	Plain: audit(map[string]fiql.Field{
		"id":                      {Column: "t.id", Kind: fiql.Number},
		"controllerid":            {Column: "t.controller_id"},
		"name":                    {Column: "t.name"},
		"description":             {Column: "t.description"},
		"group":                   {Column: "t.target_group"},
		"fleet":                   {Column: "(SELECT fl.name FROM fleets fl WHERE fl.id = t.fleet_id)"},
		"updatestatus":            {Column: "t.update_status", Kind: fiql.Enum, Values: []string{"registered", "pending", "in_sync", "error", "unknown"}},
		"ipaddress":               {Column: "regexp_replace(coalesce(t.address, ''), '^[a-z]+://', '')"},
		"address":                 {Column: "t.address"},
		"lastcontrollerrequestat": {Column: "t.last_request_at", Kind: fiql.Number},
		"installedat":             {Column: "t.installed_at", Kind: fiql.Number},
		"targettype.name":         {Column: "(SELECT tt.name FROM target_types tt WHERE tt.id = t.target_type_id)"},
		"targettype.key":          {Column: "(SELECT tt.type_key FROM target_types tt WHERE tt.id = t.target_type_id)"},
		"targettype.id":           {Column: "t.target_type_id", Kind: fiql.Number},
		"assignedds.name":         {Column: "(SELECT x.name FROM distribution_sets x WHERE x.id = t.assigned_ds_id)"},
		"assignedds.version":      {Column: "(SELECT x.version FROM distribution_sets x WHERE x.id = t.assigned_ds_id)"},
		"assignedds.id":           {Column: "t.assigned_ds_id", Kind: fiql.Number},
		"installedds.name":        {Column: "(SELECT x.name FROM distribution_sets x WHERE x.id = t.installed_ds_id)"},
		"installedds.version":     {Column: "(SELECT x.version FROM distribution_sets x WHERE x.id = t.installed_ds_id)"},
		"installedds.id":          {Column: "t.installed_ds_id", Kind: fiql.Number},
		"tag": {Custom: fiql.Exists(
			"target_tag_assignments ta JOIN target_tags tg ON tg.id = ta.tag_id WHERE ta.target_id = t.id", "tg.name")},
	}, "t"),
	Prefix: map[string]func(string) fiql.Field{
		"attribute": func(k string) fiql.Field {
			return fiql.KeyValue("target_attributes", "target_id", "t.id", "attr_key", "attr_value", k)
		},
		"metadata": func(k string) fiql.Field {
			return fiql.KeyValue("target_metadata", "target_id", "t.id", "meta_key", "meta_value", k)
		},
	},
}

// A set is complete when no module type its type makes mandatory is missing.
const dsComplete = `NOT EXISTS (
	SELECT 1 FROM ds_type_sm_types req
	WHERE req.ds_type_id = d.type_id AND req.mandatory
	  AND NOT EXISTS (SELECT 1 FROM ds_modules dm JOIN software_modules sm ON sm.id = dm.sm_id
	                  WHERE dm.ds_id = d.id AND sm.type_id = req.sm_type_id))`

var dsFields = &fiql.Fields{
	Plain: audit(map[string]fiql.Field{
		"id":                    {Column: "d.id", Kind: fiql.Number},
		"name":                  {Column: "d.name"},
		"version":               {Column: "d.version"},
		"description":           {Column: "d.description"},
		"type":                  {Column: "(SELECT y.type_key FROM ds_types y WHERE y.id = d.type_id)"},
		"complete":              {Column: "(" + dsComplete + ")", Kind: fiql.Bool},
		"valid":                 {Column: "d.valid", Kind: fiql.Bool},
		"locked":                {Column: "d.locked", Kind: fiql.Bool},
		"requiredmigrationstep": {Column: "d.required_migration_step", Kind: fiql.Bool},
		"tag": {Custom: fiql.Exists(
			"ds_tag_assignments ta JOIN ds_tags tg ON tg.id = ta.tag_id WHERE ta.ds_id = d.id", "tg.name")},
		"module": {Custom: fiql.Exists(
			"ds_modules dm JOIN software_modules sm ON sm.id = dm.sm_id WHERE dm.ds_id = d.id", "sm.name")},
	}, "d"),
	Prefix: map[string]func(string) fiql.Field{
		"metadata": func(k string) fiql.Field {
			return fiql.KeyValue("ds_metadata", "ds_id", "d.id", "meta_key", "meta_value", k)
		},
	},
}

var smFields = &fiql.Fields{
	Plain: audit(map[string]fiql.Field{
		"id":          {Column: "m.id", Kind: fiql.Number},
		"name":        {Column: "m.name"},
		"version":     {Column: "m.version"},
		"description": {Column: "m.description"},
		"vendor":      {Column: "m.vendor"},
		"type":        {Column: "(SELECT y.type_key FROM sm_types y WHERE y.id = m.type_id)"},
		"encrypted":   {Column: "m.encrypted", Kind: fiql.Bool},
		"locked":      {Column: "m.locked", Kind: fiql.Bool},
	}, "m"),
	Prefix: map[string]func(string) fiql.Field{
		"metadata": func(k string) fiql.Field {
			return fiql.KeyValue("sm_metadata", "sm_id", "m.id", "meta_key", "meta_value", k)
		},
	},
}

var rolloutFields = &fiql.Fields{Plain: audit(map[string]fiql.Field{
	"id":          {Column: "r.id", Kind: fiql.Number},
	"name":        {Column: "r.name"},
	"description": {Column: "r.description"},
	"status": {Column: "r.status", Kind: fiql.Enum, Values: []string{"creating", "ready", "waiting_for_approval",
		"approval_denied", "starting", "running", "paused", "stopping", "stopped", "finished", "deleting", "deleted"}},
	"distributionset.id":      {Column: "r.ds_id", Kind: fiql.Number},
	"distributionset.name":    {Column: "(SELECT x.name FROM distribution_sets x WHERE x.id = r.ds_id)"},
	"distributionset.version": {Column: "(SELECT x.version FROM distribution_sets x WHERE x.id = r.ds_id)"},
}, "r")}

var rolloutGroupFields = &fiql.Fields{Plain: audit(map[string]fiql.Field{
	"id":          {Column: "g.id", Kind: fiql.Number},
	"name":        {Column: "g.name"},
	"description": {Column: "g.description"},
	"status":      {Column: "g.status"},
}, "g")}

var actionFields = &fiql.Fields{Plain: audit(map[string]fiql.Field{
	"id": {Column: "a.id", Kind: fiql.Number},
	"status": {Column: "a.status", Kind: fiql.Enum, Values: []string{"running", "finished", "error", "warning",
		"canceled", "canceling", "retrieved", "download", "downloaded", "scheduled", "cancel_rejected", "wait_for_confirmation"}},
	"active":                  {Column: "a.active", Kind: fiql.Bool},
	"weight":                  {Column: "a.weight", Kind: fiql.Number},
	"externalref":             {Column: "a.external_ref"},
	"laststatuscode":          {Column: "a.last_status_code", Kind: fiql.Number},
	"forcetype":               {Column: "a.action_type"},
	"target.id":               {Column: "a.target_id", Kind: fiql.Number},
	"target.controllerid":     {Column: "(SELECT x.controller_id FROM targets x WHERE x.id = a.target_id)"},
	"target.name":             {Column: "(SELECT x.name FROM targets x WHERE x.id = a.target_id)"},
	"distributionset.id":      {Column: "a.ds_id", Kind: fiql.Number},
	"distributionset.name":    {Column: "(SELECT x.name FROM distribution_sets x WHERE x.id = a.ds_id)"},
	"distributionset.version": {Column: "(SELECT x.version FROM distribution_sets x WHERE x.id = a.ds_id)"},
	"rollout.id":              {Column: "a.rollout_id", Kind: fiql.Number},
	"rollout.name":            {Column: "(SELECT x.name FROM rollouts x WHERE x.id = a.rollout_id)"},
	"rolloutgroup.id":         {Column: "a.rollout_group_id", Kind: fiql.Number},
	"rolloutgroup.name":       {Column: "(SELECT x.name FROM rollout_groups x WHERE x.id = a.rollout_group_id)"},
}, "a")}

var actionStatusFields = &fiql.Fields{Plain: map[string]fiql.Field{
	"id":         {Column: "s.id", Kind: fiql.Number},
	"status":     {Column: "s.status"},
	"reportedat": {Column: "s.reported_at", Kind: fiql.Number},
	"timestamp":  {Column: "s.occurred_at", Kind: fiql.Number},
}}

var filterFields = &fiql.Fields{Plain: audit(map[string]fiql.Field{
	"id":                                {Column: "f.id", Kind: fiql.Number},
	"name":                              {Column: "f.name"},
	"query":                             {Column: "f.query"},
	"autoassigndistributionset.name":    {Column: "(SELECT x.name FROM distribution_sets x WHERE x.id = f.auto_assign_ds_id)"},
	"autoassigndistributionset.version": {Column: "(SELECT x.version FROM distribution_sets x WHERE x.id = f.auto_assign_ds_id)"},
}, "f")}

var tagFields = &fiql.Fields{Plain: audit(map[string]fiql.Field{
	"id":          {Column: "g.id", Kind: fiql.Number},
	"name":        {Column: "g.name"},
	"description": {Column: "g.description"},
	"colour":      {Column: "g.colour"},
}, "g")}

var smTypeFields = &fiql.Fields{Plain: audit(map[string]fiql.Field{
	"id":             {Column: "y.id", Kind: fiql.Number},
	"key":            {Column: "y.type_key"},
	"name":           {Column: "y.name"},
	"description":    {Column: "y.description"},
	"maxassignments": {Column: "y.max_assignments", Kind: fiql.Number},
}, "y")}

var dsTypeFields = &fiql.Fields{Plain: audit(map[string]fiql.Field{
	"id":          {Column: "y.id", Kind: fiql.Number},
	"key":         {Column: "y.type_key"},
	"name":        {Column: "y.name"},
	"description": {Column: "y.description"},
}, "y")}

var targetTypeFields = &fiql.Fields{Plain: audit(map[string]fiql.Field{
	"id":          {Column: "y.id", Kind: fiql.Number},
	"key":         {Column: "y.type_key"},
	"name":        {Column: "y.name"},
	"description": {Column: "y.description"},
}, "y")}

var artifactFields = &fiql.Fields{Plain: audit(map[string]fiql.Field{
	"id":       {Column: "ar.id", Kind: fiql.Number},
	"filename": {Column: "ar.filename"},
	"size":     {Column: "ar.size", Kind: fiql.Number},
}, "ar")}

var metadataFields = &fiql.Fields{Plain: map[string]fiql.Field{
	"key":   {Column: "md.meta_key"},
	"value": {Column: "md.meta_value"},
}}
