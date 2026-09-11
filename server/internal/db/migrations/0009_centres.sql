-- Centres (a Qawk addition).
--
-- A device says which centre it is in (attribute.centerid by default; the
-- field is a setting), and a centre is in a channel: every device of the
-- centre is put in that channel -- the 6hd with its st05 and hyper, and the
-- neo-intel alike -- and moving a centre from beta to prod moves them all. A
-- device lent to a temporary channel (a machine at a trade show) stays there
-- until it is sent home.
CREATE TABLE qawk_settings (
    tenant TEXT NOT NULL,
    key    TEXT NOT NULL,
    value  TEXT NOT NULL,
    PRIMARY KEY (tenant, key)
);

CREATE TABLE centres (
    tenant           TEXT   NOT NULL,
    centre           TEXT   NOT NULL,
    name             TEXT   NOT NULL DEFAULT '',
    fleet_id         BIGINT REFERENCES fleets (id) ON DELETE SET NULL,
    last_modified_at BIGINT NOT NULL,
    last_modified_by TEXT   NOT NULL,
    PRIMARY KEY (tenant, centre)
);
