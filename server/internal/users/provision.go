package users

// USERS FROM A FILE (QAWK_USERS_FILE). A server starts with one user, the
// administrator from its environment. The others can be made in the console
// or through the API -- or be written in a file the server reads when it
// starts, for a deployment that must come up with its people already there:
//
//	users:
//	  - username: release-manager-1
//	    password: at-least-eight-characters
//	    roles: [release-manager]
//	  - username: operator-1
//	    password: another-password
//	    display_name: The night operator
//	    roles: [operator]
//	    enabled: true
//
// Each user in the file is created if missing, and otherwise brought to what
// the file says: its roles, whether it may sign in, its display name when one
// is given, and its password -- written only when it differs, so a restart
// leaves no trace in the audit log. Users not in the file are left alone. The
// same rules as the API apply (a valid name, a password of 8 characters,
// roles that exist, never the administrator's name); a file that breaks them
// stops the server, rather than leaving it up without the people it expects.

import (
	"context"
	"fmt"
	"os"
	"strings"

	"go.yaml.in/yaml/v3"

	"qawk/internal/model"
)

// ProvisionActor is who the changes a users file makes are recorded as.
const ProvisionActor = "users-file"

type fileUser struct {
	Username    string   `yaml:"username"`
	Password    string   `yaml:"password"`
	DisplayName string   `yaml:"display_name"`
	Roles       []string `yaml:"roles"`
	Enabled     *bool    `yaml:"enabled"`
}

// Provision brings the users listed in the file at path into the database.
func (d *Directory) Provision(ctx context.Context, path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("users file: %w", err)
	}
	var f struct {
		Users []fileUser `yaml:"users"`
	}
	if err := yaml.Unmarshal(raw, &f); err != nil {
		return fmt.Errorf("users file %s: %w", path, err)
	}
	created, updated := 0, 0
	for i, fu := range f.Users {
		name := strings.TrimSpace(fu.Username)
		where := fmt.Sprintf("users file %s, user %d (%s)", path, i+1, name)
		enabled := fu.Enabled == nil || *fu.Enabled
		have, hash, err := d.st.UserCredentials(ctx, name)
		if err != nil {
			// not there yet
			u := model.User{Username: name, DisplayName: fu.DisplayName, Roles: fu.Roles, Enabled: enabled}
			if _, err := d.CreateUser(ctx, ProvisionActor, u, fu.Password); err != nil {
				return fmt.Errorf("%s: %w", where, err)
			}
			created++
			continue
		}
		u := have
		u.Roles, u.Enabled = fu.Roles, enabled
		if fu.DisplayName != "" {
			u.DisplayName = fu.DisplayName
		}
		if !sameUser(have, u) {
			if err := d.UpdateUser(ctx, ProvisionActor, u); err != nil {
				return fmt.Errorf("%s: %w", where, err)
			}
			updated++
		}
		if !d.verify(hash, fu.Password) {
			if err := d.SetPassword(ctx, ProvisionActor, have.ID, fu.Password); err != nil {
				return fmt.Errorf("%s: %w", where, err)
			}
			updated++
		}
	}
	d.log.Info("users from file", "file", path, "users", len(f.Users), "created", created, "changed", updated)
	return nil
}

func sameUser(a, b model.User) bool {
	if a.Enabled != b.Enabled || a.DisplayName != b.DisplayName || len(a.Roles) != len(b.Roles) {
		return false
	}
	for i := range a.Roles {
		if a.Roles[i] != b.Roles[i] {
			return false
		}
	}
	return true
}
