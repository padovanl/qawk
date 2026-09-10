-- Qawk - the first schema.
--
-- One table per thing hawkBit exposes, with the same vocabulary, so that a row
-- here and an object in the Management API are the same thing with the same
-- name. Every table carries a tenant: there is one ("DEFAULT") today, but the
-- DDI URL already names it, and adding a second later must not mean migrating
-- every row.
--
-- Times are epoch milliseconds (BIGINT), because that is what the API speaks;
-- storing TIMESTAMPTZ would mean converting on every read for no gain.
--
-- Deleting is soft where hawkBit's is soft (software modules, distribution
-- sets, types, rollouts): a deleted row stays, hidden, so the actions that
-- point at it keep their history. Unlike hawkBit, a soft-deleted name and
-- version are NOT reserved for ever -- the uniqueness constraints only cover
-- rows that are not deleted, so a set can be deleted and uploaded again.

CREATE TABLE sm_types (
    id               BIGSERIAL PRIMARY KEY,
    tenant           TEXT    NOT NULL,
    type_key         TEXT    NOT NULL,
    name             TEXT    NOT NULL,
    description      TEXT    NOT NULL DEFAULT '',
    colour           TEXT,
    max_assignments  INTEGER NOT NULL DEFAULT 1,
    min_artifacts    INTEGER NOT NULL DEFAULT 0,
    deleted          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       BIGINT  NOT NULL,
    created_by       TEXT    NOT NULL,
    last_modified_at BIGINT  NOT NULL,
    last_modified_by TEXT    NOT NULL
);
CREATE UNIQUE INDEX sm_types_key  ON sm_types (tenant, type_key) WHERE NOT deleted;
CREATE UNIQUE INDEX sm_types_name ON sm_types (tenant, name)     WHERE NOT deleted;

CREATE TABLE ds_types (
    id               BIGSERIAL PRIMARY KEY,
    tenant           TEXT    NOT NULL,
    type_key         TEXT    NOT NULL,
    name             TEXT    NOT NULL,
    description      TEXT    NOT NULL DEFAULT '',
    colour           TEXT,
    deleted          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       BIGINT  NOT NULL,
    created_by       TEXT    NOT NULL,
    last_modified_at BIGINT  NOT NULL,
    last_modified_by TEXT    NOT NULL
);
CREATE UNIQUE INDEX ds_types_key  ON ds_types (tenant, type_key) WHERE NOT deleted;
CREATE UNIQUE INDEX ds_types_name ON ds_types (tenant, name)     WHERE NOT deleted;

-- Which module types a set of this type must have (mandatory) or may have.
CREATE TABLE ds_type_sm_types (
    ds_type_id BIGINT  NOT NULL REFERENCES ds_types (id) ON DELETE CASCADE,
    sm_type_id BIGINT  NOT NULL REFERENCES sm_types (id) ON DELETE CASCADE,
    mandatory  BOOLEAN NOT NULL,
    PRIMARY KEY (ds_type_id, sm_type_id)
);

CREATE TABLE target_types (
    id               BIGSERIAL PRIMARY KEY,
    tenant           TEXT   NOT NULL,
    type_key         TEXT   NOT NULL,
    name             TEXT   NOT NULL,
    description      TEXT   NOT NULL DEFAULT '',
    colour           TEXT,
    created_at       BIGINT NOT NULL,
    created_by       TEXT   NOT NULL,
    last_modified_at BIGINT NOT NULL,
    last_modified_by TEXT   NOT NULL
);
CREATE UNIQUE INDEX target_types_key  ON target_types (tenant, type_key);
CREATE UNIQUE INDEX target_types_name ON target_types (tenant, name);

-- A target of this type accepts sets of these types, and only these.
CREATE TABLE target_type_ds_types (
    target_type_id BIGINT NOT NULL REFERENCES target_types (id) ON DELETE CASCADE,
    ds_type_id     BIGINT NOT NULL REFERENCES ds_types (id)     ON DELETE CASCADE,
    PRIMARY KEY (target_type_id, ds_type_id)
);

CREATE TABLE software_modules (
    id               BIGSERIAL PRIMARY KEY,
    tenant           TEXT    NOT NULL,
    type_id          BIGINT  NOT NULL REFERENCES sm_types (id),
    name             TEXT    NOT NULL,
    version          TEXT    NOT NULL,
    description      TEXT    NOT NULL DEFAULT '',
    vendor           TEXT    NOT NULL DEFAULT '',
    encrypted        BOOLEAN NOT NULL DEFAULT FALSE,
    locked           BOOLEAN NOT NULL DEFAULT FALSE,
    deleted          BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       BIGINT  NOT NULL,
    created_by       TEXT    NOT NULL,
    last_modified_at BIGINT  NOT NULL,
    last_modified_by TEXT    NOT NULL
);
CREATE UNIQUE INDEX software_modules_nvt ON software_modules (tenant, name, version, type_id) WHERE NOT deleted;

CREATE TABLE sm_metadata (
    sm_id          BIGINT  NOT NULL REFERENCES software_modules (id) ON DELETE CASCADE,
    meta_key       TEXT    NOT NULL,
    meta_value     TEXT    NOT NULL DEFAULT '',
    target_visible BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (sm_id, meta_key)
);

-- The bytes live in the artifact store, addressed by their SHA-256; this is
-- what the API says about them.
CREATE TABLE artifacts (
    id               BIGSERIAL PRIMARY KEY,
    sm_id            BIGINT NOT NULL REFERENCES software_modules (id) ON DELETE CASCADE,
    filename         TEXT   NOT NULL,
    sha1             TEXT   NOT NULL,
    md5              TEXT   NOT NULL,
    sha256           TEXT   NOT NULL,
    size             BIGINT NOT NULL,
    created_at       BIGINT NOT NULL,
    created_by       TEXT   NOT NULL,
    last_modified_at BIGINT NOT NULL,
    last_modified_by TEXT   NOT NULL,
    UNIQUE (sm_id, filename)
);
CREATE INDEX artifacts_sha256 ON artifacts (sha256);

CREATE TABLE distribution_sets (
    id                      BIGSERIAL PRIMARY KEY,
    tenant                  TEXT    NOT NULL,
    type_id                 BIGINT  NOT NULL REFERENCES ds_types (id),
    name                    TEXT    NOT NULL,
    version                 TEXT    NOT NULL,
    description             TEXT    NOT NULL DEFAULT '',
    required_migration_step BOOLEAN NOT NULL DEFAULT FALSE,
    locked                  BOOLEAN NOT NULL DEFAULT FALSE,
    valid                   BOOLEAN NOT NULL DEFAULT TRUE,
    deleted                 BOOLEAN NOT NULL DEFAULT FALSE,
    created_at              BIGINT  NOT NULL,
    created_by              TEXT    NOT NULL,
    last_modified_at        BIGINT  NOT NULL,
    last_modified_by        TEXT    NOT NULL
);
CREATE UNIQUE INDEX distribution_sets_nv ON distribution_sets (tenant, name, version) WHERE NOT deleted;

CREATE TABLE ds_modules (
    ds_id BIGINT NOT NULL REFERENCES distribution_sets (id) ON DELETE CASCADE,
    sm_id BIGINT NOT NULL REFERENCES software_modules (id),
    PRIMARY KEY (ds_id, sm_id)
);
CREATE INDEX ds_modules_sm ON ds_modules (sm_id);

CREATE TABLE ds_metadata (
    ds_id      BIGINT NOT NULL REFERENCES distribution_sets (id) ON DELETE CASCADE,
    meta_key   TEXT   NOT NULL,
    meta_value TEXT   NOT NULL DEFAULT '',
    PRIMARY KEY (ds_id, meta_key)
);

CREATE TABLE ds_tags (
    id               BIGSERIAL PRIMARY KEY,
    tenant           TEXT   NOT NULL,
    name             TEXT   NOT NULL,
    description      TEXT   NOT NULL DEFAULT '',
    colour           TEXT,
    created_at       BIGINT NOT NULL,
    created_by       TEXT   NOT NULL,
    last_modified_at BIGINT NOT NULL,
    last_modified_by TEXT   NOT NULL
);
CREATE UNIQUE INDEX ds_tags_name ON ds_tags (tenant, name);

CREATE TABLE ds_tag_assignments (
    tag_id BIGINT NOT NULL REFERENCES ds_tags (id)          ON DELETE CASCADE,
    ds_id  BIGINT NOT NULL REFERENCES distribution_sets (id) ON DELETE CASCADE,
    PRIMARY KEY (tag_id, ds_id)
);

CREATE TABLE targets (
    id                     BIGSERIAL PRIMARY KEY,
    tenant                 TEXT    NOT NULL,
    controller_id          TEXT    NOT NULL,
    name                   TEXT    NOT NULL,
    description            TEXT    NOT NULL DEFAULT '',
    target_type_id         BIGINT  REFERENCES target_types (id) ON DELETE SET NULL,
    security_token         TEXT    NOT NULL,
    address                TEXT,
    last_request_at        BIGINT,
    installed_at           BIGINT,
    assigned_ds_id         BIGINT  REFERENCES distribution_sets (id),
    installed_ds_id        BIGINT  REFERENCES distribution_sets (id),
    update_status          TEXT    NOT NULL DEFAULT 'registered',
    request_attributes     BOOLEAN NOT NULL DEFAULT TRUE,
    auto_confirm_active    BOOLEAN NOT NULL DEFAULT FALSE,
    auto_confirm_initiator TEXT,
    auto_confirm_remark    TEXT,
    auto_confirm_at        BIGINT,
    created_at             BIGINT  NOT NULL,
    created_by             TEXT    NOT NULL,
    last_modified_at       BIGINT  NOT NULL,
    last_modified_by       TEXT    NOT NULL
);
CREATE UNIQUE INDEX targets_controller ON targets (tenant, controller_id);

CREATE TABLE target_attributes (
    target_id  BIGINT NOT NULL REFERENCES targets (id) ON DELETE CASCADE,
    attr_key   TEXT   NOT NULL,
    attr_value TEXT   NOT NULL DEFAULT '',
    PRIMARY KEY (target_id, attr_key)
);

CREATE TABLE target_metadata (
    target_id  BIGINT NOT NULL REFERENCES targets (id) ON DELETE CASCADE,
    meta_key   TEXT   NOT NULL,
    meta_value TEXT   NOT NULL DEFAULT '',
    PRIMARY KEY (target_id, meta_key)
);

CREATE TABLE target_tags (
    id               BIGSERIAL PRIMARY KEY,
    tenant           TEXT   NOT NULL,
    name             TEXT   NOT NULL,
    description      TEXT   NOT NULL DEFAULT '',
    colour           TEXT,
    created_at       BIGINT NOT NULL,
    created_by       TEXT   NOT NULL,
    last_modified_at BIGINT NOT NULL,
    last_modified_by TEXT   NOT NULL
);
CREATE UNIQUE INDEX target_tags_name ON target_tags (tenant, name);

CREATE TABLE target_tag_assignments (
    tag_id    BIGINT NOT NULL REFERENCES target_tags (id) ON DELETE CASCADE,
    target_id BIGINT NOT NULL REFERENCES targets (id)     ON DELETE CASCADE,
    PRIMARY KEY (tag_id, target_id)
);

CREATE TABLE target_filters (
    id                      BIGSERIAL PRIMARY KEY,
    tenant                  TEXT    NOT NULL,
    name                    TEXT    NOT NULL,
    query                   TEXT    NOT NULL,
    auto_assign_ds_id       BIGINT  REFERENCES distribution_sets (id) ON DELETE SET NULL,
    auto_assign_action_type TEXT,
    auto_assign_weight      INTEGER,
    confirmation_required   BOOLEAN,
    created_at              BIGINT  NOT NULL,
    created_by              TEXT    NOT NULL,
    last_modified_at        BIGINT  NOT NULL,
    last_modified_by        TEXT    NOT NULL
);
CREATE UNIQUE INDEX target_filters_name ON target_filters (tenant, name);

CREATE TABLE rollouts (
    id                    BIGSERIAL PRIMARY KEY,
    tenant                TEXT    NOT NULL,
    name                  TEXT    NOT NULL,
    description           TEXT    NOT NULL DEFAULT '',
    ds_id                 BIGINT  NOT NULL REFERENCES distribution_sets (id),
    target_filter_query   TEXT    NOT NULL,
    action_type           TEXT    NOT NULL DEFAULT 'forced',
    forced_time           BIGINT  NOT NULL DEFAULT 0,
    weight                INTEGER,
    status                TEXT    NOT NULL,
    dynamic               BOOLEAN NOT NULL DEFAULT FALSE,
    start_at              BIGINT,
    confirmation_required BOOLEAN,
    approval_decided_by   TEXT,
    approval_remark       TEXT,
    total_targets         BIGINT  NOT NULL DEFAULT 0,
    deleted               BOOLEAN NOT NULL DEFAULT FALSE,
    created_at            BIGINT  NOT NULL,
    created_by            TEXT    NOT NULL,
    last_modified_at      BIGINT  NOT NULL,
    last_modified_by      TEXT    NOT NULL
);
CREATE UNIQUE INDEX rollouts_name ON rollouts (tenant, name) WHERE NOT deleted;

CREATE TABLE rollout_groups (
    id                     BIGSERIAL PRIMARY KEY,
    rollout_id             BIGINT  NOT NULL REFERENCES rollouts (id) ON DELETE CASCADE,
    position               INTEGER NOT NULL,
    name                   TEXT    NOT NULL,
    description            TEXT    NOT NULL DEFAULT '',
    status                 TEXT    NOT NULL,
    target_filter_query    TEXT    NOT NULL DEFAULT '',
    target_percentage      DOUBLE PRECISION NOT NULL DEFAULT 100,
    success_condition      TEXT    NOT NULL DEFAULT 'THRESHOLD',
    success_condition_exp  TEXT    NOT NULL DEFAULT '100',
    success_action         TEXT    NOT NULL DEFAULT 'NEXTGROUP',
    success_action_exp     TEXT    NOT NULL DEFAULT '',
    error_condition        TEXT,
    error_condition_exp    TEXT,
    error_action           TEXT,
    error_action_exp       TEXT,
    confirmation_required  BOOLEAN,
    dynamic                BOOLEAN NOT NULL DEFAULT FALSE,
    total_targets          BIGINT  NOT NULL DEFAULT 0,
    created_at             BIGINT  NOT NULL,
    created_by             TEXT    NOT NULL,
    last_modified_at       BIGINT  NOT NULL,
    last_modified_by       TEXT    NOT NULL
);
CREATE INDEX rollout_groups_rollout ON rollout_groups (rollout_id, position);

CREATE TABLE rollout_group_targets (
    group_id  BIGINT NOT NULL REFERENCES rollout_groups (id) ON DELETE CASCADE,
    target_id BIGINT NOT NULL REFERENCES targets (id)        ON DELETE CASCADE,
    PRIMARY KEY (group_id, target_id)
);
CREATE INDEX rollout_group_targets_target ON rollout_group_targets (target_id);

-- An action is one distribution set sent to one target: the unit a device
-- polls, installs and reports on. Its status is the LAST status reported,
-- exactly as in hawkBit, and the history is in action_status.
CREATE TABLE actions (
    id                   BIGSERIAL PRIMARY KEY,
    tenant               TEXT    NOT NULL,
    target_id            BIGINT  NOT NULL REFERENCES targets (id) ON DELETE CASCADE,
    ds_id                BIGINT  NOT NULL REFERENCES distribution_sets (id),
    action_type          TEXT    NOT NULL DEFAULT 'forced',
    forced_time          BIGINT  NOT NULL DEFAULT 0,
    status               TEXT    NOT NULL,
    active               BOOLEAN NOT NULL DEFAULT TRUE,
    weight               INTEGER,
    rollout_id           BIGINT  REFERENCES rollouts (id)       ON DELETE SET NULL,
    rollout_group_id     BIGINT  REFERENCES rollout_groups (id) ON DELETE SET NULL,
    maintenance_schedule TEXT,
    maintenance_duration TEXT,
    maintenance_timezone TEXT,
    initiated_by         TEXT    NOT NULL DEFAULT '',
    external_ref         TEXT,
    last_status_code     INTEGER,
    created_at           BIGINT  NOT NULL,
    created_by           TEXT    NOT NULL,
    last_modified_at     BIGINT  NOT NULL,
    last_modified_by     TEXT    NOT NULL
);
CREATE INDEX actions_target  ON actions (target_id, id DESC);
CREATE INDEX actions_active  ON actions (target_id) WHERE active;
CREATE INDEX actions_rollout ON actions (rollout_id, rollout_group_id);

CREATE TABLE action_status (
    id          BIGSERIAL PRIMARY KEY,
    action_id   BIGINT  NOT NULL REFERENCES actions (id) ON DELETE CASCADE,
    status      TEXT    NOT NULL,
    occurred_at BIGINT  NOT NULL,
    reported_at BIGINT  NOT NULL,
    code        INTEGER,
    messages    TEXT[]  NOT NULL DEFAULT '{}'
);
CREATE INDEX action_status_action ON action_status (action_id, id DESC);

-- Tenant configuration: the keys of /rest/v1/system/configs. A key that is not
-- here has its default, and the API says "global": true for it.
CREATE TABLE tenant_configs (
    tenant           TEXT   NOT NULL,
    config_key       TEXT   NOT NULL,
    config_value     JSONB  NOT NULL,
    created_at       BIGINT NOT NULL,
    created_by       TEXT   NOT NULL,
    last_modified_at BIGINT NOT NULL,
    last_modified_by TEXT   NOT NULL,
    PRIMARY KEY (tenant, config_key)
);
