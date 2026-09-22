-- The orchestrator keeps its scope (a Qawk addition).
--
-- A channel's release keeps reaching new members for as long as it is the
-- channel's release: a device that registers into prod, or a centre moved
-- into prod, is given prod's set. Its MANIFEST did not: the systems were
-- chosen once, when the release started, so a centre moved into prod
-- afterwards got nothing at all -- its standalone devices took prod's set,
-- and its systems were left out of the orchestrator and, being system
-- members, out of the channel's delivery too. They waited for ever, in
-- silence. The orchestrator now asks again every tick, as the channel does.
--
-- And the centres are taken in an order that can be chosen: a channel may
-- name its centres, and they go in that order, one after the other.

-- The centres a channel's orchestrator takes, in the order it takes them.
-- Empty (the default): every centre of the channel, by name.
ALTER TABLE fleets ADD COLUMN orch_centres TEXT[];

-- A run's place in that order, so the engine reads the runs back in it.
ALTER TABLE system_runs ADD COLUMN group_rank INT NOT NULL DEFAULT 0;
