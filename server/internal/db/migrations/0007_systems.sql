-- Systems (a Qawk addition, after Mender Orchestrator).
--
-- A system is a set of devices that work together and are updated together:
-- a bowling centre with its lane computers and the terminals attached to
-- them. Its type (Mender's "topology") says which components it has -- each
-- a query that recognises its devices -- and how a device says which system
-- it belongs to (an attribute or a metadata key: metadata.center). A manifest
-- is the state a system type should reach: for each component a set and an
-- order (lower first, equal orders together). A system deployment applies a
-- manifest to the systems of a type, some at a time; inside each system the
-- orders go in sequence, and when a device fails the whole system is put
-- back on what it ran before, while the other systems go on.
--
-- Mender runs its orchestrator on a device of the system; Qawk runs it on the
-- server, over devices that are each an ordinary hawkBit target.
CREATE TABLE system_types (
    id               BIGSERIAL PRIMARY KEY,
    tenant           TEXT   NOT NULL,
    name             TEXT   NOT NULL,
    description      TEXT   NOT NULL DEFAULT '',
    key_field        TEXT   NOT NULL,          -- attribute.<key> or metadata.<key>
    created_at       BIGINT NOT NULL,
    created_by       TEXT   NOT NULL,
    last_modified_at BIGINT NOT NULL,
    last_modified_by TEXT   NOT NULL
);
CREATE UNIQUE INDEX system_types_name ON system_types (tenant, name);

CREATE TABLE system_components (
    system_type_id BIGINT NOT NULL REFERENCES system_types (id) ON DELETE CASCADE,
    component_type TEXT   NOT NULL,
    match_query    TEXT   NOT NULL,             -- attribute.device_type==hd
    PRIMARY KEY (system_type_id, component_type)
);

CREATE TABLE manifests (
    id               BIGSERIAL PRIMARY KEY,
    tenant           TEXT   NOT NULL,
    name             TEXT   NOT NULL,
    description      TEXT   NOT NULL DEFAULT '',
    system_type_id   BIGINT NOT NULL REFERENCES system_types (id) ON DELETE CASCADE,
    created_at       BIGINT NOT NULL,
    created_by       TEXT   NOT NULL,
    last_modified_at BIGINT NOT NULL,
    last_modified_by TEXT   NOT NULL
);
CREATE UNIQUE INDEX manifests_name ON manifests (tenant, name);

CREATE TABLE manifest_components (
    manifest_id    BIGINT NOT NULL REFERENCES manifests (id) ON DELETE CASCADE,
    component_type TEXT   NOT NULL,
    ds_id          BIGINT NOT NULL REFERENCES distribution_sets (id),
    update_order   INT    NOT NULL,
    PRIMARY KEY (manifest_id, component_type)
);

CREATE TABLE system_deployments (
    id               BIGSERIAL PRIMARY KEY,
    tenant           TEXT    NOT NULL,
    name             TEXT    NOT NULL,
    manifest_id      BIGINT  NOT NULL REFERENCES manifests (id),
    systems          TEXT[],                    -- the systems it covers; NULL: every one of the type
    max_parallel     INT     NOT NULL DEFAULT 1,
    max_failed       INT     NOT NULL DEFAULT 0,
    action_type      TEXT    NOT NULL DEFAULT 'forced',
    -- draft, running, paused, finished, failed, aborted
    status           TEXT    NOT NULL DEFAULT 'draft',
    reason           TEXT    NOT NULL DEFAULT '',
    started_by       TEXT,
    started_at       BIGINT,
    finished_at      BIGINT,
    created_at       BIGINT  NOT NULL,
    created_by       TEXT    NOT NULL,
    last_modified_at BIGINT  NOT NULL,
    last_modified_by TEXT    NOT NULL
);
CREATE UNIQUE INDEX system_deployments_name ON system_deployments (tenant, name);

-- One system of a deployment.
CREATE TABLE system_runs (
    id            BIGSERIAL PRIMARY KEY,
    deployment_id BIGINT NOT NULL REFERENCES system_deployments (id) ON DELETE CASCADE,
    system_key    TEXT   NOT NULL,
    -- pending, running, succeeded, rolling_back, rolled_back, skipped
    status        TEXT   NOT NULL DEFAULT 'pending',
    current_order INT,
    reason        TEXT   NOT NULL DEFAULT '',
    started_at    BIGINT,
    stage_at      BIGINT,
    rollback_at   BIGINT,
    finished_at   BIGINT,
    UNIQUE (deployment_id, system_key)
);

-- The devices of a run, and what each ran when the run began.
CREATE TABLE system_run_targets (
    run_id         BIGINT  NOT NULL REFERENCES system_runs (id) ON DELETE CASCADE,
    target_id      BIGINT  NOT NULL REFERENCES targets (id) ON DELETE CASCADE,
    component_type TEXT    NOT NULL,
    update_order   INT     NOT NULL,
    ds_id          BIGINT  NOT NULL,
    previous_ds_id BIGINT,
    already        BOOLEAN NOT NULL DEFAULT false,
    assigned       BOOLEAN NOT NULL DEFAULT false,
    rollback_sent  BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (run_id, target_id)
);
CREATE INDEX system_run_targets_order ON system_run_targets (run_id, update_order);
