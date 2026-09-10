-- Fleets (a Qawk addition): beta, production, staging...
--
-- A fleet is a set of devices that should run the same release. A device is
-- in at most one fleet, so which release it should run is never in doubt.
-- Nothing on the device changes: membership is the server's business, decided
-- by hand or by a rule written in the query language, over what the devices
-- already report about themselves (device_type, versions, slot...).
CREATE TABLE fleets (
    id               BIGSERIAL PRIMARY KEY,
    tenant           TEXT   NOT NULL,
    name             TEXT   NOT NULL,
    description      TEXT   NOT NULL DEFAULT '',
    colour           TEXT,
    -- a target query: matching devices that are in no fleet join this one
    rule             TEXT,
    -- the release the fleet runs: members behind it are given it
    ds_id            BIGINT REFERENCES distribution_sets (id) ON DELETE SET NULL,
    action_type      TEXT   NOT NULL DEFAULT 'forced',
    created_at       BIGINT NOT NULL,
    created_by       TEXT   NOT NULL,
    last_modified_at BIGINT NOT NULL,
    last_modified_by TEXT   NOT NULL
);
CREATE UNIQUE INDEX fleets_name ON fleets (tenant, name);

ALTER TABLE targets ADD COLUMN fleet_id BIGINT REFERENCES fleets (id) ON DELETE SET NULL;
CREATE INDEX targets_fleet ON targets (fleet_id);
