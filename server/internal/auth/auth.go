// Package auth is what a request knows about who made it: the user, for
// createdBy and lastModifiedBy, and the permissions every route checks.
//
// Who may sign in, and with what, is package users; the DDI side (gateway and
// target tokens) lives with the DDI handlers, because it depends on the
// tenant configuration and on the target itself.
package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"time"
)

type ctxKey struct{}

// User returns who made the request, for createdBy and lastModifiedBy.
func User(ctx context.Context) string {
	if u, ok := ctx.Value(ctxKey{}).(string); ok {
		return u
	}
	return "system"
}

// WithUser marks ctx as acting for user -- the DDI side uses it to record a
// device's own actions, and background jobs to record "system".
func WithUser(ctx context.Context, user string) context.Context {
	return context.WithValue(ctx, ctxKey{}, user)
}

// ------------------------------------------------------------- permissions
//
// hawkBit's permissions, by name: READ_TARGET, UPDATE_REPOSITORY,
// HANDLE_ROLLOUT, TENANT_CONFIGURATION and the rest. Every Management route
// declares the one it needs; a user's roles (package users) say which they
// have.

type permsKey struct{}

// All grants every permission.
const All = "*"

func WithPermissions(ctx context.Context, perms ...string) context.Context {
	set := make(map[string]bool, len(perms))
	for _, p := range perms {
		set[p] = true
	}
	return context.WithValue(ctx, permsKey{}, set)
}

func Can(ctx context.Context, perm string) bool {
	set, _ := ctx.Value(permsKey{}).(map[string]bool)
	return set[All] || set[perm]
}

// Require refuses a request whose user lacks perm, with hawkBit's 403.
func Require(perm string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !Can(r.Context(), perm) {
				w.Header().Set("Content-Type", "application/hal+json")
				w.WriteHeader(http.StatusForbidden)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"errorCode":      "hawkbit.server.error.insufficientpermission",
					"exceptionClass": "org.eclipse.hawkbit.im.authentication.InsufficientPermissionException",
					"message":        "Insufficient Permission: " + perm + " is required",
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// Unauthorized writes the 401 hawkBit's Management API answers with.
func Unauthorized(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"timestamp": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		"status":    401,
		"error":     "Unauthorized",
		"path":      r.URL.Path,
	})
}
