-- A channel's release through the orchestrator (a Qawk addition).
--
-- A channel's release is one set for every member -- which a 6hd and the st05
-- and hyper under it cannot share: each needs its own, in order. So a release
-- may carry, besides its set, a MANIFEST: when the release starts in a
-- channel, a system deployment takes the channel's systems with it (centre by
-- centre, if the channel says so), while the set goes to the devices that
-- stand alone (a neo-intel). Promoted -- by hand or by itself -- the release
-- takes its manifest along the pipeline, as it takes its set.
ALTER TABLE fleet_releases ADD COLUMN manifest_id BIGINT REFERENCES manifests (id) ON DELETE SET NULL;
ALTER TABLE fleet_releases ADD COLUMN manifest_label TEXT NOT NULL DEFAULT '';
ALTER TABLE fleet_releases ADD COLUMN system_deployment_id BIGINT REFERENCES system_deployments (id) ON DELETE SET NULL;
-- the manifest of the fleet's current release, as ds_id is its set
ALTER TABLE fleets ADD COLUMN manifest_id BIGINT REFERENCES manifests (id) ON DELETE SET NULL;
-- how the release's orchestrator takes the fleet's systems
ALTER TABLE fleets ADD COLUMN orch_max_parallel INT NOT NULL DEFAULT 4;
ALTER TABLE fleets ADD COLUMN orch_max_failed INT NOT NULL DEFAULT 0;
ALTER TABLE fleets ADD COLUMN orch_by_centre BOOLEAN NOT NULL DEFAULT true;
-- a system deployment may go one group (centre) at a time; each run knows its centre
ALTER TABLE system_deployments ADD COLUMN by_group BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE system_runs ADD COLUMN group_key TEXT NOT NULL DEFAULT '';
