// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

// Package users is who may use the Management API and Qawk's own, and what
// each may do (a Qawk addition: hawkBit keeps its users in its configuration
// file).
//
// Three kinds of credentials are accepted, checked in this order:
//
//   - the administrator from the environment (QAWK_ADMIN_USER and
//     QAWK_ADMIN_PASSWORD), with every permission. It always works, so a new
//     server can be set up and a lost password is fixed by a restart;
//   - an API token, "qawk_...", as "Authorization: Bearer <token>" or as the
//     password of basic authentication, for tools that only speak that (curl
//     -u, our upload script). A token acts with its owner's permissions;
//   - a user stored in the database, with a password and roles. A role is a
//     named set of hawkBit's permissions.
//
// A password is stored as PBKDF2-SHA256 with 600,000 iterations, which costs
// a noticeable fraction of a second to check. The console sends the password
// with every request, so a successful check is remembered for thirty seconds;
// every change to a user, a role or a token forgets them all on this
// instance, and the others follow within those thirty seconds.
package users

import (
	"context"
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5"

	"qawk/internal/auth"
	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/store"
)

// Principal is who made a request, and how they proved it.
type Principal struct {
	User   string
	Via    string // config, password or token
	Perms  []string
	UserID *int64 // nil: the administrator from the environment
}

func (p Principal) Can(perm string) bool {
	return slices.Contains(p.Perms, auth.All) || slices.Contains(p.Perms, perm)
}

type principalKey struct{}

// From returns the principal of an authenticated request.
func From(ctx context.Context) (Principal, bool) {
	p, ok := ctx.Value(principalKey{}).(Principal)
	return p, ok
}

type Directory struct {
	st        *store.Store
	adminUser string
	adminPass string
	auditDays int
	log       *slog.Logger

	mu      sync.Mutex
	cache   map[string]cached
	hashing chan struct{} // at most this many password checks at once
}

type cached struct {
	p     Principal
	until time.Time
}

const cacheFor = 30 * time.Second

func New(st *store.Store, adminUser, adminPass string, auditDays int, log *slog.Logger) *Directory {
	return &Directory{st: st, adminUser: adminUser, adminPass: adminPass, auditDays: auditDays, log: log,
		cache: map[string]cached{}, hashing: make(chan struct{}, 4)}
}

// Seed writes the built-in roles.
func (d *Directory) Seed(ctx context.Context) error { return d.st.EnsureRoles(ctx, Builtin) }

// ------------------------------------------------------------ authentication

// Authenticate checks a request's credentials. who is the name they claimed,
// "" when there were none at all.
func (d *Directory) Authenticate(r *http.Request) (p Principal, ok bool, who string) {
	ctx := r.Context()
	if h := r.Header.Get("Authorization"); len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		p, ok := d.byToken(ctx, strings.TrimSpace(h[7:]), "")
		return p, ok, "(token)"
	}
	u, pw, found := r.BasicAuth()
	if !found {
		return Principal{}, false, ""
	}
	if subtle.ConstantTimeCompare([]byte(u), []byte(d.adminUser)) == 1 &&
		subtle.ConstantTimeCompare([]byte(pw), []byte(d.adminPass)) == 1 {
		return Principal{User: u, Via: "config", Perms: []string{auth.All}}, true, u
	}
	if strings.HasPrefix(pw, TokenPrefix) {
		p, ok := d.byToken(ctx, pw, u)
		return p, ok, u
	}
	p, ok = d.byPassword(ctx, u, pw)
	return p, ok, u
}

func (d *Directory) byToken(ctx context.Context, tok, user string) (Principal, bool) {
	h := tokenHash(tok)
	if p, ok := d.recall("t" + h); ok {
		return p, user == "" || strings.EqualFold(user, p.User)
	}
	t, err := d.st.TokenByHash(ctx, h)
	if err != nil {
		return Principal{}, false
	}
	now := httpx.Now()
	if t.ExpiresAt != nil && *t.ExpiresAt <= now {
		return Principal{}, false
	}
	if user != "" && !strings.EqualFold(user, t.Username) {
		return Principal{}, false
	}
	var perms []string
	if t.UserID == nil {
		// the administrator's: dead if QAWK_ADMIN_USER has changed since
		if !strings.EqualFold(t.Username, d.adminUser) {
			return Principal{}, false
		}
		perms = []string{auth.All}
	} else {
		u, _, err := d.st.UserCredentials(ctx, t.Username)
		if err != nil || !u.Enabled {
			return Principal{}, false
		}
		if perms, err = d.st.PermissionsOf(ctx, u.Roles); err != nil {
			return Principal{}, false
		}
	}
	d.st.TouchToken(ctx, t.ID, now)
	p := Principal{User: t.Username, Via: "token", Perms: perms, UserID: t.UserID}
	d.remember("t"+h, p)
	return p, true
}

func (d *Directory) byPassword(ctx context.Context, user, pw string) (Principal, bool) {
	sum := sha256.Sum256([]byte(user + "\x00" + pw))
	key := "p" + hex.EncodeToString(sum[:])
	if p, ok := d.recall(key); ok {
		return p, true
	}
	u, hash, err := d.st.UserCredentials(ctx, user)
	if err != nil || !u.Enabled || !d.verify(hash, pw) {
		return Principal{}, false
	}
	perms, err := d.st.PermissionsOf(ctx, u.Roles)
	if err != nil {
		return Principal{}, false
	}
	d.st.TouchLogin(ctx, u.ID, httpx.Now())
	id := u.ID
	p := Principal{User: u.Username, Via: "password", Perms: perms, UserID: &id}
	d.remember(key, p)
	return p, true
}

func (d *Directory) recall(key string) (Principal, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	c, ok := d.cache[key]
	if !ok || time.Now().After(c.until) {
		delete(d.cache, key)
		return Principal{}, false
	}
	return c.p, true
}

func (d *Directory) remember(key string, p Principal) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.cache) > 10000 {
		d.cache = map[string]cached{}
	}
	d.cache[key] = cached{p, time.Now().Add(cacheFor)}
}

// Invalidate forgets every credential already checked on this instance.
func (d *Directory) Invalidate() {
	d.mu.Lock()
	d.cache = map[string]cached{}
	d.mu.Unlock()
}

// Middleware authenticates every request, refuses those it cannot with
// hawkBit's 401, and writes the audit log: every request that changes
// something, and every sign-in refused.
func (d *Directory) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p, ok, who := d.Authenticate(r)
		if !ok {
			if who != "" {
				d.record(r, who, "-", http.StatusUnauthorized)
			}
			auth.Unauthorized(w, r)
			return
		}
		ctx := auth.WithPermissions(auth.WithUser(r.Context(), p.User), p.Perms...)
		r = r.WithContext(context.WithValue(ctx, principalKey{}, p))
		if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
			next.ServeHTTP(w, r)
			return
		}
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		next.ServeHTTP(ww, r)
		status := ww.Status()
		if status == 0 {
			status = http.StatusOK
		}
		d.record(r, p.User, p.Via, status)
	})
}

func (d *Directory) record(r *http.Request, user, via string, status int) {
	addr := r.Header.Get("X-Forwarded-For")
	if i := strings.IndexByte(addr, ','); i >= 0 {
		addr = addr[:i]
	}
	addr = strings.TrimSpace(addr)
	if addr == "" {
		addr, _, _ = net.SplitHostPort(r.RemoteAddr)
	}
	// not the request's context: a client that hangs up still gets recorded
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := d.st.AddAudit(ctx, model.AuditEntry{At: httpx.Now(), User: user, Via: via,
		Method: r.Method, Path: r.URL.Path, Status: status, Address: addr}); err != nil {
		d.log.Warn("audit log", "err", err)
	}
}

// PruneAudit forgets what is older than QAWK_AUDIT_DAYS.
func (d *Directory) PruneAudit(ctx context.Context) {
	if d.auditDays <= 0 {
		return
	}
	n, err := d.st.PruneAudit(ctx, httpx.Now()-int64(d.auditDays)*86_400_000)
	if err != nil {
		d.log.Warn("audit log pruning", "err", err)
	} else if n > 0 {
		d.log.Info("audit log pruned", "entries", n, "days", d.auditDays)
	}
}

// ------------------------------------------------------------ passwords

const iterations = 600_000

var b64 = base64.RawStdEncoding

func hashPassword(pw string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	k, err := pbkdf2.Key(sha256.New, pw, salt, iterations, 32)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("pbkdf2-sha256$%d$%s$%s", iterations, b64.EncodeToString(salt), b64.EncodeToString(k)), nil
}

func (d *Directory) verify(stored, pw string) bool {
	d.hashing <- struct{}{}
	defer func() { <-d.hashing }()
	parts := strings.Split(stored, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2-sha256" {
		return false
	}
	n, err := strconv.Atoi(parts[1])
	if err != nil || n < 1 {
		return false
	}
	salt, err1 := b64.DecodeString(parts[2])
	want, err2 := b64.DecodeString(parts[3])
	if err1 != nil || err2 != nil {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, pw, salt, n, len(want))
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}

func checkPassword(pw string) error {
	if len(pw) < 8 {
		return httpx.Validation("a password needs at least 8 characters")
	}
	return nil
}

// ------------------------------------------------------------ tokens

// TokenPrefix starts every token, so that one pasted where a password goes is
// recognised as a token -- and one leaked into a log is easy to search for.
const TokenPrefix = "qawk_"

func newToken() (string, error) {
	b := make([]byte, 24)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return TokenPrefix + hex.EncodeToString(b), nil
}

func tokenHash(t string) string {
	s := sha256.Sum256([]byte(t))
	return hex.EncodeToString(s[:])
}

// CreateToken makes a token for p, valid for days (0: until revoked). The
// token itself is returned this once and never again.
func (d *Directory) CreateToken(ctx context.Context, p Principal, name string, days int) (string, model.APIToken, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return "", model.APIToken{}, httpx.Validation("a token needs a name, to recognise it later")
	}
	if days < 0 || days > 3650 {
		return "", model.APIToken{}, httpx.Validation("a token lasts from 1 to 3650 days, or 0 for until revoked")
	}
	tok, err := newToken()
	if err != nil {
		return "", model.APIToken{}, err
	}
	t := model.APIToken{UserID: p.UserID, Username: p.User, Name: name, Hint: tok[len(tok)-4:], CreatedAt: httpx.Now()}
	if days > 0 {
		e := t.CreatedAt + int64(days)*86_400_000
		t.ExpiresAt = &e
	}
	t.ID, err = d.st.CreateToken(ctx, t, tokenHash(tok))
	return tok, t, err
}

// Tokens lists p's tokens, or everyone's when all is set.
func (d *Directory) Tokens(ctx context.Context, p Principal, all bool) ([]model.APIToken, error) {
	if all {
		return d.st.Tokens(ctx, "")
	}
	return d.st.Tokens(ctx, p.User)
}

// RevokeToken deletes one of p's tokens; an administrator may revoke anyone's.
func (d *Directory) RevokeToken(ctx context.Context, p Principal, id int64) error {
	owner := p.User
	if p.Can(Admin) {
		owner = ""
	}
	if err := d.st.DeleteToken(ctx, id, owner); err != nil {
		return err
	}
	d.Invalidate()
	return nil
}

// ------------------------------------------------------------ users

var validName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$`)

func (d *Directory) checkRoles(ctx context.Context, q store.Q, names []string) error {
	for _, n := range names {
		if _, err := d.st.Role(ctx, q, n); err != nil {
			return httpx.Validation("there is no role " + n)
		}
	}
	return nil
}

func (d *Directory) CreateUser(ctx context.Context, actor string, u model.User, password string) (int64, error) {
	u.Username = strings.TrimSpace(u.Username)
	if !validName.MatchString(u.Username) {
		return 0, httpx.Validation("a user name is 1 to 64 letters, digits and . _ @ -, starting with a letter or digit")
	}
	if strings.EqualFold(u.Username, d.adminUser) {
		return 0, httpx.Validation(u.Username + " is the administrator from the server's configuration")
	}
	if err := checkPassword(password); err != nil {
		return 0, err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return 0, err
	}
	var id int64
	err = d.st.Tx(ctx, actor, func(tx pgx.Tx, now int64) error {
		if err := d.checkRoles(ctx, tx, u.Roles); err != nil {
			return err
		}
		var err error
		id, err = d.st.CreateUser(ctx, tx, actor, now, u, hash)
		return err
	})
	return id, err
}

// UpdateUser stores a user's name for display, roles and whether it may sign in.
func (d *Directory) UpdateUser(ctx context.Context, actor string, u model.User) error {
	err := d.st.Tx(ctx, actor, func(tx pgx.Tx, now int64) error {
		if _, err := d.st.User(ctx, tx, u.ID); err != nil {
			return err
		}
		if err := d.checkRoles(ctx, tx, u.Roles); err != nil {
			return err
		}
		return d.st.UpdateUser(ctx, tx, actor, now, u)
	})
	if err == nil {
		d.Invalidate()
	}
	return err
}

func (d *Directory) SetPassword(ctx context.Context, actor string, id int64, password string) error {
	if err := checkPassword(password); err != nil {
		return err
	}
	hash, err := hashPassword(password)
	if err != nil {
		return err
	}
	err = d.st.Tx(ctx, actor, func(tx pgx.Tx, now int64) error {
		if _, err := d.st.User(ctx, tx, id); err != nil {
			return err
		}
		return d.st.SetPassword(ctx, tx, actor, now, id, hash)
	})
	if err == nil {
		d.Invalidate()
	}
	return err
}

// ChangeOwnPassword is a user changing their own password, which needs the
// current one.
func (d *Directory) ChangeOwnPassword(ctx context.Context, p Principal, current, password string) error {
	if p.UserID == nil {
		return httpx.Validation("this account is the administrator from the server's configuration: " +
			"its password is QAWK_ADMIN_PASSWORD, set where the server runs")
	}
	_, hash, err := d.st.UserCredentials(ctx, p.User)
	if err != nil {
		return err
	}
	if !d.verify(hash, current) {
		return httpx.Validation("the current password is not right")
	}
	return d.SetPassword(ctx, p.User, *p.UserID, password)
}

func (d *Directory) DeleteUser(ctx context.Context, actor Principal, id int64) error {
	if actor.UserID != nil && *actor.UserID == id {
		return httpx.Validation("you cannot delete yourself")
	}
	err := d.st.Tx(ctx, actor.User, func(tx pgx.Tx, now int64) error {
		if _, err := d.st.User(ctx, tx, id); err != nil {
			return err
		}
		return d.st.DeleteUser(ctx, tx, id)
	})
	if err == nil {
		d.Invalidate()
	}
	return err
}

// ------------------------------------------------------------ roles

// SaveRole creates a role, or changes one. The built-in roles are not
// changed this way.
func (d *Directory) SaveRole(ctx context.Context, actor string, x model.Role, create bool) error {
	x.Name = strings.TrimSpace(x.Name)
	if !validName.MatchString(x.Name) {
		return httpx.Validation("a role name is 1 to 64 letters, digits and . _ @ -")
	}
	if builtin(x.Name) {
		return httpx.Validation("the role " + x.Name + " is built in and cannot be changed")
	}
	perms := []string{}
	for _, p := range x.Permissions {
		if !known(p) {
			return httpx.Validation("there is no permission " + p)
		}
		if !slices.Contains(perms, p) {
			perms = append(perms, p)
		}
	}
	x.Permissions = perms
	err := d.st.Tx(ctx, actor, func(tx pgx.Tx, now int64) error {
		if create {
			return d.st.CreateRole(ctx, tx, actor, now, x)
		}
		if _, err := d.st.Role(ctx, tx, x.Name); err != nil {
			return err
		}
		return d.st.UpdateRole(ctx, tx, actor, now, x)
	})
	if err == nil {
		d.Invalidate()
	}
	return err
}

func (d *Directory) DeleteRole(ctx context.Context, actor, name string) error {
	if builtin(name) {
		return httpx.Validation("the role " + name + " is built in and cannot be deleted")
	}
	err := d.st.Tx(ctx, actor, func(tx pgx.Tx, now int64) error {
		if _, err := d.st.Role(ctx, tx, name); err != nil {
			return err
		}
		return d.st.DeleteRole(ctx, tx, name)
	})
	if err == nil {
		d.Invalidate()
	}
	return err
}
