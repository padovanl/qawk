// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package server

import (
	"context"

	"qawk/internal/metrics"
	"qawk/internal/service"
	"qawk/internal/store"
)

// fleetGauges is what /metrics reads at each scrape: the fleet's devices by
// update status, what is in flight, and each fleet's progress. With many
// instances every one answers with the same database numbers and its own
// request counters; sum the counters, not the gauges.
func fleetGauges(st *store.Store, svc *service.Service) metrics.Source {
	return func(ctx context.Context) ([]metrics.Gauge, error) {
		s, err := st.Stats(ctx)
		if err != nil {
			return nil, err
		}
		var g []metrics.Gauge
		add := func(name, help string, v float64, kv ...string) {
			l := map[string]string{}
			for i := 0; i+1 < len(kv); i += 2 {
				l[kv[i]] = kv[i+1]
			}
			g = append(g, metrics.Gauge{Name: name, Help: help, Labels: l, Value: v})
		}
		for status, n := range s.TargetsByStatus {
			add("qawk_targets", "Targets, by update status.", float64(n), "status", status)
		}
		add("qawk_actions_active", "Actions not yet closed.", float64(s.ActionsActive))
		add("qawk_rollouts_running", "Rollouts running.", float64(s.RolloutsRunning))
		add("qawk_fleet_releases_pending", "Fleet releases waiting for approval.", float64(s.ReleasesPending))
		add("qawk_fleet_releases_halted", "Fleet releases halted by their error threshold.", float64(s.ReleasesHalted))
		fleets, err := st.Fleets(ctx)
		if err != nil {
			return nil, err
		}
		for _, f := range fleets {
			add("qawk_fleet_devices", "Devices in a fleet.", float64(f.Members), "fleet", f.Name)
			add("qawk_fleet_on_release", "Devices of a fleet running its release.", float64(f.OnRelease), "fleet", f.Name)
			add("qawk_fleet_updating", "Devices of a fleet with an action open.", float64(f.Updating), "fleet", f.Name)
			add("qawk_fleet_failed", "Devices of a fleet whose last update failed.", float64(f.Failed), "fleet", f.Name)
		}
		acq, idle, total := st.PoolStats()
		add("qawk_db_connections", "This instance's database connections.", float64(acq), "state", "acquired")
		add("qawk_db_connections", "This instance's database connections.", float64(idle), "state", "idle")
		add("qawk_db_connections", "This instance's database connections.", float64(total), "state", "total")
		lead := 0.0
		if svc.Leading() {
			lead = 1
		}
		add("qawk_leader", "1 on the instance running the background jobs.", lead)
		return g, nil
	}
}
