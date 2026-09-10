-- Users, roles, API tokens and an audit log (a Qawk addition).
--
-- hawkBit keeps its users in its configuration file: one password per user,
-- set when the server starts. Here they live in the database, so they are
-- managed from the console and shared by every instance. The administrator
-- from the environment (QAWK_ADMIN_USER / QAWK_ADMIN_PASSWORD) is not stored:
-- it always works, whatever is in these tables.

-- A role is a named set of hawkBit's permissions (READ_TARGET, ...; "*" is
-- all of them). The built-in ones are written by the server at every start.
CREATE TABLE roles (
    tenant           TEXT    NOT NULL,
    name             TEXT    NOT NULL,
    description      TEXT    NOT NULL DEFAULT '',
    permissions      TEXT[]  NOT NULL DEFAULT '{}',
    builtin          BOOLEAN NOT NULL DEFAULT false,
    created_at       BIGINT  NOT NULL,
    created_by       TEXT    NOT NULL,
    last_modified_at BIGINT  NOT NULL,
    last_modified_by TEXT    NOT NULL,
    PRIMARY KEY (tenant, name)
);

CREATE TABLE users (
    id               BIGSERIAL PRIMARY KEY,
    tenant           TEXT    NOT NULL,
    username         TEXT    NOT NULL,
    display_name     TEXT    NOT NULL DEFAULT '',
    -- pbkdf2-sha256$<iterations>$<salt>$<key>, base64 without padding
    password_hash    TEXT    NOT NULL,
    roles            TEXT[]  NOT NULL DEFAULT '{}',
    enabled          BOOLEAN NOT NULL DEFAULT true,
    last_login_at    BIGINT,
    created_at       BIGINT  NOT NULL,
    created_by       TEXT    NOT NULL,
    last_modified_at BIGINT  NOT NULL,
    last_modified_by TEXT    NOT NULL
);
CREATE UNIQUE INDEX users_name ON users (tenant, lower(username));

-- A token acts for its owner, with the owner's permissions at the time of
-- use. Only its SHA-256 is kept: the token itself is shown once, at creation.
CREATE TABLE api_tokens (
    id           BIGSERIAL PRIMARY KEY,
    tenant       TEXT   NOT NULL,
    -- NULL: a token of the administrator from the environment
    user_id      BIGINT REFERENCES users (id) ON DELETE CASCADE,
    username     TEXT   NOT NULL,
    name         TEXT   NOT NULL,
    token_hash   TEXT   NOT NULL UNIQUE,
    hint         TEXT   NOT NULL,
    created_at   BIGINT NOT NULL,
    expires_at   BIGINT,
    last_used_at BIGINT
);
CREATE INDEX api_tokens_user ON api_tokens (tenant, lower(username));

-- Every request that changes something, and every refused sign-in.
CREATE TABLE audit_log (
    id       BIGSERIAL PRIMARY KEY,
    tenant   TEXT   NOT NULL,
    at       BIGINT NOT NULL,
    username TEXT   NOT NULL,
    via      TEXT   NOT NULL,
    method   TEXT   NOT NULL,
    path     TEXT   NOT NULL,
    status   INT    NOT NULL,
    address  TEXT   NOT NULL DEFAULT ''
);
CREATE INDEX audit_log_at ON audit_log (tenant, at DESC);
