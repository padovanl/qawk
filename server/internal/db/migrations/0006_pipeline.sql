-- The release pipeline (a Qawk addition): dev -> beta -> prod, expo aside.
--
-- A fleet may name its upstream: the fleet it takes releases from, by
-- promotion. The gate says what the upstream must show before a release may
-- enter (how many devices run it, what share of the fleet, for how long), and
-- a fleet may need a second person to approve. Inside a fleet a release goes
-- out in waves, and stops by itself when too many devices fail.
ALTER TABLE fleets
    ADD COLUMN upstream_id          BIGINT  REFERENCES fleets (id) ON DELETE SET NULL,
    -- devices come back from it: a trade-show fleet remembers where they belong
    ADD COLUMN temporary            BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN gate_min_devices     INT     NOT NULL DEFAULT 1,
    ADD COLUMN gate_min_success     INT     NOT NULL DEFAULT 100,
    ADD COLUMN gate_soak_minutes    INT     NOT NULL DEFAULT 0,
    ADD COLUMN approval_required    BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN wave_percent         INT     NOT NULL DEFAULT 0,
    ADD COLUMN wave_timeout_minutes INT     NOT NULL DEFAULT 60,
    ADD COLUMN error_threshold      INT     NOT NULL DEFAULT 0,
    -- a freeze: no release reaches the fleet from freeze_from to freeze_until
    -- (either may be open); set when freeze_reason is
    ADD COLUMN freeze_reason        TEXT,
    ADD COLUMN freeze_from          BIGINT,
    ADD COLUMN freeze_until         BIGINT;

ALTER TABLE targets
    ADD COLUMN fleet_joined_at BIGINT,
    ADD COLUMN home_fleet_id   BIGINT REFERENCES fleets (id) ON DELETE SET NULL;
UPDATE targets SET fleet_joined_at = 0 WHERE fleet_id IS NOT NULL;

-- Every release a fleet was given or asked for: the history, the approvals
-- waiting, and the state of the one going out now.
CREATE TABLE fleet_releases (
    id               BIGSERIAL PRIMARY KEY,
    tenant           TEXT    NOT NULL,
    fleet_id         BIGINT  NOT NULL REFERENCES fleets (id) ON DELETE CASCADE,
    ds_id            BIGINT  REFERENCES distribution_sets (id) ON DELETE SET NULL,
    ds_label         TEXT    NOT NULL DEFAULT '',
    from_fleet_id    BIGINT  REFERENCES fleets (id) ON DELETE SET NULL,
    from_fleet_name  TEXT    NOT NULL DEFAULT '',
    -- waiting_for_approval, denied, active, halted, completed, superseded
    status           TEXT    NOT NULL,
    forced           BOOLEAN NOT NULL DEFAULT false,
    reason           TEXT    NOT NULL DEFAULT '',
    gate_report      TEXT    NOT NULL DEFAULT '',
    requested_by     TEXT    NOT NULL,
    requested_at     BIGINT  NOT NULL,
    decided_by       TEXT,
    decided_at       BIGINT,
    started_at       BIGINT,
    finished_at      BIGINT,
    waves            INT     NOT NULL DEFAULT 0,
    last_wave_at     BIGINT,
    -- failures already counted when a halted release was resumed
    failure_baseline INT     NOT NULL DEFAULT 0
);
CREATE INDEX fleet_releases_fleet   ON fleet_releases (fleet_id, id DESC);
CREATE INDEX fleet_releases_pending ON fleet_releases (tenant) WHERE status = 'waiting_for_approval';

-- the releases fleets already had
INSERT INTO fleet_releases (tenant, fleet_id, ds_id, status, requested_by, requested_at, started_at)
SELECT tenant, id, ds_id, 'active', last_modified_by, last_modified_at, 0 FROM fleets WHERE ds_id IS NOT NULL;
