// Package config reads Qawk's settings from the environment.
//
// Everything that differs between a laptop, the demo bench and a real server
// is an environment variable: it is how containers are configured, and it
// keeps the image the same everywhere. Nothing here is read after startup.
package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// Listen is the address the HTTP server binds to. hawkBit's port by
	// default, so a device pointed at hawkBit reaches Qawk unchanged.
	Listen string

	// DatabaseURL is a PostgreSQL connection string.
	DatabaseURL string

	// DBWait is how long to wait for the database at startup.
	DBWait time.Duration

	// DBMaxConns is the size of this instance's connection pool. Across all
	// instances it must stay under PostgreSQL's max_connections.
	DBMaxConns int32

	// ArtifactDir is where artifact bytes are stored, one file per SHA-256.
	ArtifactDir string

	// Tenant is the single tenant this instance serves. The DDI URL carries a
	// tenant; a request for another one is answered 404, as hawkBit does for an
	// unknown tenant.
	Tenant string

	// AdminUser / AdminPassword authenticate the Management API.
	AdminUser     string
	AdminPassword string

	// UsersFile, when set, is a YAML file of users the server creates or
	// brings up to date at every start (users/provision.go).
	UsersFile string

	// PublicURL, when set, is the base of every link Qawk hands out (the
	// download URLs a device follows, the _links of the Management API).
	// When empty, links are built from the request's own scheme and Host,
	// which is right as long as the device reaches Qawk at the address it
	// used to poll -- the usual case, and the one hawkBit relies on too.
	PublicURL string

	// DefaultPollingTime is the polling interval until someone changes the
	// "pollingTime" tenant configuration.
	DefaultPollingTime string

	// AuditDays is how long the audit log is kept; 0 keeps it for ever.
	AuditDays int

	// MetricsToken, when set, is the bearer token /metrics wants.
	MetricsToken string

	// CORSOrigins are the web origins allowed to call the API from a browser,
	// comma separated, or "*" for any. Empty (the default) sends no CORS
	// header at all, which is what a server only devices and scripts talk to
	// wants: a browser then refuses to read an answer meant for someone else.
	// Set it for a front end of your own, or for the documentation's "send
	// this request" button.
	CORSOrigins []string

	// TLSCert and TLSKey, both set, make the server speak HTTPS itself
	// instead of plain HTTP. Empty (the default) is plain HTTP, which is
	// right behind a proxy that terminates TLS for you.
	TLSCert, TLSKey string

	// TLSClientCA, with TLS on, is a PEM bundle of the authorities whose
	// client certificates are accepted. Set it and a device must present one:
	// mutual TLS, in front of every other check.
	TLSClientCA string

	// RedirectHTTP, with TLS on, is an extra plain-HTTP address that answers
	// every request with a redirect to the HTTPS one -- ":8080", so a device
	// still pointed at the old URL is told where to go.
	RedirectHTTP string

	LogLevel string
}

// TLS says whether this server terminates TLS itself.
func (c Config) TLS() bool { return c.TLSCert != "" && c.TLSKey != "" }

// CORSAllowed says whether an Origin may read this server's answers.
func (c Config) CORSAllowed(origin string) bool {
	for _, o := range c.CORSOrigins {
		if o == "*" || strings.EqualFold(o, origin) {
			return true
		}
	}
	return false
}

func env(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}

func Load() (Config, error) {
	c := Config{
		Listen:             env("QAWK_LISTEN", ":8080"),
		DatabaseURL:        env("QAWK_DATABASE_URL", "postgres://qawk:qawk@localhost:5432/qawk?sslmode=disable"),
		ArtifactDir:        env("QAWK_ARTIFACT_DIR", "/var/lib/qawk/artifacts"),
		Tenant:             env("QAWK_TENANT", "DEFAULT"),
		AdminUser:          env("QAWK_ADMIN_USER", "admin"),
		AdminPassword:      env("QAWK_ADMIN_PASSWORD", "admin"),
		UsersFile:          env("QAWK_USERS_FILE", ""),
		PublicURL:          strings.TrimRight(env("QAWK_PUBLIC_URL", ""), "/"),
		DefaultPollingTime: env("QAWK_POLLING_TIME", "00:05:00"),
		LogLevel:           env("QAWK_LOG_LEVEL", "info"),
		MetricsToken:       env("QAWK_METRICS_TOKEN", ""),
	}
	for _, o := range strings.Split(env("QAWK_CORS_ORIGINS", ""), ",") {
		if o = strings.TrimRight(strings.TrimSpace(o), "/"); o != "" {
			c.CORSOrigins = append(c.CORSOrigins, o)
		}
	}
	c.TLSCert, c.TLSKey = env("QAWK_TLS_CERT", ""), env("QAWK_TLS_KEY", "")
	c.TLSClientCA, c.RedirectHTTP = env("QAWK_TLS_CLIENT_CA", ""), env("QAWK_REDIRECT_HTTP", "")
	// half a pair is a typo, and a server that quietly fell back to plain
	// HTTP because of one would be the worst possible answer to it
	if (c.TLSCert == "") != (c.TLSKey == "") {
		return c, fmt.Errorf("QAWK_TLS_CERT and QAWK_TLS_KEY go together: set both, or neither")
	}
	if !c.TLS() {
		if c.TLSClientCA != "" {
			return c, fmt.Errorf("QAWK_TLS_CLIENT_CA needs QAWK_TLS_CERT and QAWK_TLS_KEY")
		}
		if c.RedirectHTTP != "" {
			return c, fmt.Errorf("QAWK_REDIRECT_HTTP needs QAWK_TLS_CERT and QAWK_TLS_KEY: " +
				"without TLS there would be nowhere to redirect to")
		}
	}
	for _, f := range []struct{ what, path string }{
		{"QAWK_TLS_CERT", c.TLSCert}, {"QAWK_TLS_KEY", c.TLSKey}, {"QAWK_TLS_CLIENT_CA", c.TLSClientCA},
	} {
		if f.path == "" {
			continue
		}
		if _, err := os.Stat(f.path); err != nil {
			return c, fmt.Errorf("%s: %w", f.what, err)
		}
	}
	if c.TLS() && c.RedirectHTTP == c.Listen {
		return c, fmt.Errorf("QAWK_REDIRECT_HTTP must differ from QAWK_LISTEN (%s)", c.Listen)
	}
	if c.AdminPassword == "" {
		return c, fmt.Errorf("QAWK_ADMIN_PASSWORD must not be empty")
	}
	n, err := strconv.Atoi(env("QAWK_DB_MAX_CONNS", "20"))
	if err != nil || n < 2 {
		return c, fmt.Errorf("QAWK_DB_MAX_CONNS must be a number of at least 2")
	}
	c.DBMaxConns = int32(n)
	w, err := time.ParseDuration(env("QAWK_DB_WAIT", "5m"))
	if err != nil || w <= 0 {
		return c, fmt.Errorf("QAWK_DB_WAIT must be a duration such as 90s or 5m")
	}
	c.DBWait = w
	d, err := strconv.Atoi(env("QAWK_AUDIT_DAYS", "180"))
	if err != nil || d < 0 {
		return c, fmt.Errorf("QAWK_AUDIT_DAYS must be a number of days, 0 for for ever")
	}
	c.AuditDays = d
	return c, nil
}
