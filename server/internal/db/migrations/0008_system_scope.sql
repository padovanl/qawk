-- Systems in channels (a Qawk addition).
--
-- A 6hd with its st05 and hyper sits in a channel (a fleet) like any device,
-- and in a centre. A system deployment can take the systems of one channel,
-- and of some centres only; the system type names the field that says the
-- centre (attribute.centerid). A device that is part of a system is updated
-- by system deployments, not by its channel's release -- a channel's release
-- is one set for every member, which a 6hd and the st05 under it cannot share
-- -- so the engine keeps system_members, and the fleets leave those alone.
ALTER TABLE system_types ADD COLUMN group_field TEXT NOT NULL DEFAULT '';

ALTER TABLE system_deployments ADD COLUMN fleet_id BIGINT REFERENCES fleets (id) ON DELETE SET NULL;
ALTER TABLE system_deployments ADD COLUMN groups TEXT[];

CREATE TABLE system_members (
    target_id      BIGINT NOT NULL REFERENCES targets (id) ON DELETE CASCADE,
    system_type_id BIGINT NOT NULL REFERENCES system_types (id) ON DELETE CASCADE,
    system_key     TEXT   NOT NULL,
    component_type TEXT   NOT NULL,
    PRIMARY KEY (target_id, system_type_id)
);
CREATE INDEX system_members_type ON system_members (system_type_id);
