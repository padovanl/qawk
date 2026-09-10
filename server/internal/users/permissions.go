package users

import (
	"slices"

	"qawk/internal/auth"
	"qawk/internal/model"
)

// Admin is the permission to manage users and roles and to read the audit
// log. hawkBit has the same name for its own system administration.
const Admin = "SYSTEM_ADMIN"

type Permission struct{ Name, Description string }

// Permissions is every permission a role can hold: hawkBit's, by name.
var Permissions = []Permission{
	{"READ_TARGET", "See targets, their actions, attributes and fleets"},
	{"CREATE_TARGET", "Register targets, create fleets"},
	{"UPDATE_TARGET", "Change targets, assign and cancel updates, manage fleets"},
	{"DELETE_TARGET", "Delete targets and fleets"},
	{"READ_TARGET_SECURITY_TOKEN", "See the targets' security tokens"},
	{"READ_REPOSITORY", "See software modules, distribution sets, artifacts and types"},
	{"CREATE_REPOSITORY", "Create modules, sets and types, upload artifacts"},
	{"UPDATE_REPOSITORY", "Change modules, sets and types"},
	{"DELETE_REPOSITORY", "Delete modules, sets, types and artifacts"},
	{"DOWNLOAD_REPOSITORY_ARTIFACT", "Download artifacts through the Management API"},
	{"READ_ROLLOUT", "See rollouts and their groups"},
	{"CREATE_ROLLOUT", "Create rollouts"},
	{"UPDATE_ROLLOUT", "Change rollouts"},
	{"DELETE_ROLLOUT", "Delete rollouts"},
	{"HANDLE_ROLLOUT", "Start, pause, resume and advance rollouts"},
	{"APPROVE_ROLLOUT", "Approve or deny rollouts"},
	{"READ_TENANT_CONFIGURATION", "See the server configuration"},
	{"TENANT_CONFIGURATION", "Change the server configuration"},
	{Admin, "Manage users and roles, read the audit log"},
}

func known(p string) bool {
	return p == auth.All || slices.ContainsFunc(Permissions, func(x Permission) bool { return x.Name == p })
}

// Expand turns "*" into every permission's name.
func Expand(perms []string) []string {
	if !slices.Contains(perms, auth.All) {
		return perms
	}
	out := make([]string, 0, len(Permissions))
	for _, p := range Permissions {
		out = append(out, p.Name)
	}
	return out
}

// Builtin are the roles every server has. They cannot be changed or deleted
// through the API; the server rewrites them at every start.
var Builtin = []model.Role{
	{Name: "admin", Description: "Everything, including users, roles and the audit log",
		Permissions: []string{auth.All}},
	{Name: "operator", Description: "Runs updates: targets, fleets, software, rollouts. Deletes nothing, configures nothing",
		Permissions: []string{"READ_TARGET", "CREATE_TARGET", "UPDATE_TARGET",
			"READ_REPOSITORY", "CREATE_REPOSITORY", "UPDATE_REPOSITORY", "DOWNLOAD_REPOSITORY_ARTIFACT",
			"READ_ROLLOUT", "CREATE_ROLLOUT", "UPDATE_ROLLOUT", "HANDLE_ROLLOUT",
			"READ_TENANT_CONFIGURATION"}},
	{Name: "viewer", Description: "Sees everything, changes nothing",
		Permissions: []string{"READ_TARGET", "READ_REPOSITORY", "READ_ROLLOUT", "READ_TENANT_CONFIGURATION"}},
}

func builtin(name string) bool {
	return slices.ContainsFunc(Builtin, func(r model.Role) bool { return r.Name == name })
}
