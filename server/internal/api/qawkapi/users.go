package qawkapi

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"qawk/internal/auth"
	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/users"
)

// /qawk/v1: users, roles, API tokens and the audit log (a Qawk addition).
//
// Anyone signed in can see who they are, change their own password and keep
// their own tokens. Everything else needs SYSTEM_ADMIN.

func (a *API) userRoutes(r chi.Router) {
	r.Get("/me", a.me)
	r.Put("/me/password", a.ownPassword)
	r.Get("/permissions", a.permissions)
	r.Get("/tokens", a.listTokens)
	r.Post("/tokens", a.createToken)
	r.Delete("/tokens/{tokenId}", a.revokeToken)
	r.Group(func(r chi.Router) {
		r.Use(auth.Require(users.Admin))
		r.Get("/users", a.listUsers)
		r.Post("/users", a.createUser)
		r.Get("/users/{userId}", a.getUser)
		r.Put("/users/{userId}", a.updateUser)
		r.Delete("/users/{userId}", a.deleteUser)
		r.Put("/users/{userId}/password", a.userPassword)
		r.Get("/roles", a.listRoles)
		r.Post("/roles", a.createRole)
		r.Put("/roles/{name}", a.updateRole)
		r.Delete("/roles/{name}", a.deleteRole)
		r.Get("/audit", a.audit)
	})
}

func principal(r *http.Request) users.Principal {
	p, _ := users.From(r.Context())
	return p
}

func pathInt(w http.ResponseWriter, r *http.Request, param, entity string) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, param), 10, 64)
	if err != nil {
		httpx.WriteError(w, httpx.NotFound(entity, chi.URLParam(r, param)))
		return 0, false
	}
	return id, true
}

func userJSON(u model.User) map[string]any {
	return map[string]any{
		"id": u.ID, "username": u.Username, "displayName": u.DisplayName, "roles": u.Roles,
		"enabled": u.Enabled, "lastLoginAt": u.LastLoginAt,
		"createdAt": u.CreatedAt, "createdBy": u.CreatedBy,
		"lastModifiedAt": u.LastModifiedAt, "lastModifiedBy": u.LastModifiedBy,
	}
}

func roleJSON(x model.Role) map[string]any {
	return map[string]any{
		"name": x.Name, "description": x.Description, "permissions": x.Permissions, "builtin": x.Builtin,
		"createdAt": x.CreatedAt, "createdBy": x.CreatedBy,
		"lastModifiedAt": x.LastModifiedAt, "lastModifiedBy": x.LastModifiedBy,
	}
}

func tokenJSON(t model.APIToken) map[string]any {
	return map[string]any{
		"id": t.ID, "user": t.Username, "name": t.Name, "hint": t.Hint,
		"createdAt": t.CreatedAt, "expiresAt": t.ExpiresAt, "lastUsedAt": t.LastUsedAt,
	}
}

// me: who the console is signed in as, and what it may do -- the console
// hides what the user may not use.
func (a *API) me(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	out := map[string]any{
		"username": p.User, "via": p.Via, "displayName": "", "roles": []string{},
		"permissions": users.Expand(p.Perms), "admin": p.Can(users.Admin),
		"configured": p.UserID == nil,
	}
	if p.UserID == nil {
		out["roles"] = []string{"admin"}
		out["displayName"] = "Administrator"
	} else if u, err := a.st.User(r.Context(), a.st.DB(), *p.UserID); err == nil {
		out["roles"], out["displayName"] = u.Roles, u.DisplayName
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

func (a *API) permissions(w http.ResponseWriter, _ *http.Request) {
	out := make([]map[string]any, 0, len(users.Permissions))
	for _, p := range users.Permissions {
		out = append(out, map[string]any{"name": p.Name, "description": p.Description})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

func (a *API) ownPassword(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Current  string `json:"current"`
		Password string `json:"password"`
	}
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	if err := a.svc.Directory().ChangeOwnPassword(r.Context(), principal(r), b.Current, b.Password); err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ------------------------------------------------------------------ users

func (a *API) listUsers(w http.ResponseWriter, r *http.Request) {
	us, err := a.st.Users(r.Context())
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(us))
	for _, u := range us {
		out = append(out, userJSON(u))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

type userBody struct {
	Username    *string   `json:"username"`
	DisplayName *string   `json:"displayName"`
	Password    *string   `json:"password"`
	Roles       *[]string `json:"roles"`
	Enabled     *bool     `json:"enabled"`
}

func (b userBody) apply(u *model.User) {
	if b.DisplayName != nil {
		u.DisplayName = *b.DisplayName
	}
	if b.Roles != nil {
		u.Roles = *b.Roles
	}
	if b.Enabled != nil {
		u.Enabled = *b.Enabled
	}
}

func (a *API) sendUser(w http.ResponseWriter, r *http.Request, id int64, status int) {
	u, err := a.st.User(r.Context(), a.st.DB(), id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, status, userJSON(u))
}

func (a *API) createUser(w http.ResponseWriter, r *http.Request) {
	var b userBody
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	if b.Username == nil || b.Password == nil {
		httpx.WriteError(w, httpx.Validation("a new user needs a username and a password"))
		return
	}
	u := model.User{Username: *b.Username, Enabled: true, Roles: []string{}}
	b.apply(&u)
	id, err := a.svc.Directory().CreateUser(r.Context(), auth.User(r.Context()), u, *b.Password)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	a.sendUser(w, r, id, http.StatusCreated)
}

func (a *API) getUser(w http.ResponseWriter, r *http.Request) {
	if id, ok := pathInt(w, r, "userId", "User"); ok {
		a.sendUser(w, r, id, http.StatusOK)
	}
}

func (a *API) updateUser(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "userId", "User")
	if !ok {
		return
	}
	var b userBody
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	u, err := a.st.User(r.Context(), a.st.DB(), id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	if b.Username != nil && *b.Username != u.Username {
		httpx.WriteError(w, httpx.Validation("a user name cannot change: create another user"))
		return
	}
	b.apply(&u)
	dir, actor := a.svc.Directory(), auth.User(r.Context())
	if err := dir.UpdateUser(r.Context(), actor, u); err != nil {
		httpx.WriteError(w, err)
		return
	}
	if b.Password != nil {
		if err := dir.SetPassword(r.Context(), actor, id, *b.Password); err != nil {
			httpx.WriteError(w, err)
			return
		}
	}
	a.sendUser(w, r, id, http.StatusOK)
}

func (a *API) userPassword(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "userId", "User")
	if !ok {
		return
	}
	var b struct {
		Password string `json:"password"`
	}
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	if err := a.svc.Directory().SetPassword(r.Context(), auth.User(r.Context()), id, b.Password); err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *API) deleteUser(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "userId", "User")
	if !ok {
		return
	}
	if err := a.svc.Directory().DeleteUser(r.Context(), principal(r), id); err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ------------------------------------------------------------------ roles

func (a *API) listRoles(w http.ResponseWriter, r *http.Request) {
	rs, err := a.st.Roles(r.Context())
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(rs))
	for _, x := range rs {
		out = append(out, roleJSON(x))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

type roleBody struct {
	Name        string   `json:"name"`
	Description string   `json:"description"`
	Permissions []string `json:"permissions"`
}

func (a *API) saveRole(w http.ResponseWriter, r *http.Request, name string, create bool) {
	var b roleBody
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	if !create {
		b.Name = name
	}
	x := model.Role{Name: b.Name, Description: b.Description, Permissions: b.Permissions}
	if err := a.svc.Directory().SaveRole(r.Context(), auth.User(r.Context()), x, create); err != nil {
		httpx.WriteError(w, err)
		return
	}
	saved, err := a.st.Role(r.Context(), a.st.DB(), x.Name)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	status := http.StatusOK
	if create {
		status = http.StatusCreated
	}
	httpx.WriteJSON(w, status, roleJSON(saved))
}

func (a *API) createRole(w http.ResponseWriter, r *http.Request) { a.saveRole(w, r, "", true) }

func (a *API) updateRole(w http.ResponseWriter, r *http.Request) {
	a.saveRole(w, r, chi.URLParam(r, "name"), false)
}

func (a *API) deleteRole(w http.ResponseWriter, r *http.Request) {
	if err := a.svc.Directory().DeleteRole(r.Context(), auth.User(r.Context()), chi.URLParam(r, "name")); err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ------------------------------------------------------------------ tokens

// listTokens: your own; ?all=true shows everyone's to an administrator.
func (a *API) listTokens(w http.ResponseWriter, r *http.Request) {
	p := principal(r)
	all := r.URL.Query().Get("all") == "true" && p.Can(users.Admin)
	ts, err := a.svc.Directory().Tokens(r.Context(), p, all)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(ts))
	for _, t := range ts {
		out = append(out, tokenJSON(t))
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

// createToken answers with the token itself, the only time it is shown.
func (a *API) createToken(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Name          string `json:"name"`
		ExpiresInDays int    `json:"expiresInDays"`
	}
	if e := httpx.Decode(r, &b); e != nil {
		httpx.WriteError(w, e)
		return
	}
	tok, t, err := a.svc.Directory().CreateToken(r.Context(), principal(r), b.Name, b.ExpiresInDays)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := tokenJSON(t)
	out["token"] = tok
	httpx.WriteJSON(w, http.StatusCreated, out)
}

func (a *API) revokeToken(w http.ResponseWriter, r *http.Request) {
	id, ok := pathInt(w, r, "tokenId", "Token")
	if !ok {
		return
	}
	if err := a.svc.Directory().RevokeToken(r.Context(), principal(r), id); err != nil {
		httpx.WriteError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ------------------------------------------------------------------ audit

// audit: the log, newest first, paged and filtered like any hawkBit list
// (?q=user==alice;status=ge=400&offset=0&limit=50).
func (a *API) audit(w http.ResponseWriter, r *http.Request) {
	p, e := httpx.ParsePage(r)
	if e != nil {
		httpx.WriteError(w, e)
		return
	}
	es, total, err := a.st.AuditLog(r.Context(), p)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(es))
	for _, x := range es {
		out = append(out, map[string]any{"id": x.ID, "at": x.At, "user": x.User, "via": x.Via,
			"method": x.Method, "path": x.Path, "status": x.Status, "address": x.Address})
	}
	httpx.WriteJSON(w, http.StatusOK, httpx.Paged{Content: out, Total: total, Size: len(out)})
}
