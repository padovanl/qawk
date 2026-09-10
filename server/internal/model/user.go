package model

// Users, roles, API tokens and the audit log (a Qawk addition).

type User struct {
	ID             int64
	Username       string
	DisplayName    string
	Roles          []string
	Enabled        bool
	LastLoginAt    *int64
	CreatedAt      int64
	CreatedBy      string
	LastModifiedAt int64
	LastModifiedBy string
}

// Role is a named set of hawkBit permissions; "*" is every permission.
type Role struct {
	Name           string
	Description    string
	Permissions    []string
	Builtin        bool
	CreatedAt      int64
	CreatedBy      string
	LastModifiedAt int64
	LastModifiedBy string
}

type APIToken struct {
	ID         int64
	UserID     *int64 // nil: the administrator from the environment
	Username   string
	Name       string
	Hint       string // the last four characters, to tell tokens apart
	CreatedAt  int64
	ExpiresAt  *int64
	LastUsedAt *int64
}

type AuditEntry struct {
	ID      int64
	At      int64
	User    string
	Via     string // config, password, token; "-" for a refused sign-in
	Method  string
	Path    string
	Status  int
	Address string
}
