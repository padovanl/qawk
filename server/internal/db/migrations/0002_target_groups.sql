-- Target groups (hawkBit 1.1's /rest/v1/targetgroups): a free-form label on a
-- target, "/"-separated for subgroups (Europe/Italy/Bologna), that rollouts
-- and filters can aim at.
ALTER TABLE targets ADD COLUMN target_group TEXT;
CREATE INDEX targets_group ON targets (tenant, target_group);
