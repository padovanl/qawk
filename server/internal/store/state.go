package store

import (
	"context"

	"qawk/internal/model"
)

// Batches for the console (a Qawk addition): what a page of targets needs, in
// one query each, instead of one request per row. At ten thousand devices a
// page of fifty with a release going out was a hundred and fifty requests
// every few seconds, per browser.

// TargetState is what a console needs to say what a device is doing: its
// latest action, the latest entries of that action's history, the downloads
// Qawk counted for it, and the type of the set it was assigned.
type TargetState struct {
	ControllerID string
	DSType       *string
	// what it was told to install and what it runs: name, version, type
	Assigned, Installed *SetRef
	// the fleet it is in, and the colour the fleet is drawn in
	Fleet, FleetColour *string
	ActionID           *int64
	Active             bool
	Statuses           []model.ActionStatus
	Downloads          []model.Download
}

// SetRef names a distribution set.
type SetRef struct {
	ID      int64
	Name    string
	Version string
	Type    string
}

// TargetStates reads the state of these targets, keeping the newest keep
// status entries of each one's latest action.
func (s *Store) TargetStates(ctx context.Context, ids []string, keep int) (map[string]*TargetState, error) {
	out := map[string]*TargetState{}
	rows, err := s.pool.Query(ctx, `
		SELECT t.controller_id,
		       (SELECT y.type_key FROM distribution_sets d JOIN ds_types y ON y.id = d.type_id
		        WHERE d.id = t.assigned_ds_id),
		       la.id, coalesce(la.active, false),
		       ad.id, ad.name, ad.version, ay.type_key, idd.id, idd.name, idd.version, iy.type_key,
		       fl.name, fl.colour
		FROM targets t
		LEFT JOIN fleets fl ON fl.id = t.fleet_id
		LEFT JOIN distribution_sets ad ON ad.id = t.assigned_ds_id
		LEFT JOIN ds_types ay ON ay.id = ad.type_id
		LEFT JOIN distribution_sets idd ON idd.id = t.installed_ds_id
		LEFT JOIN ds_types iy ON iy.id = idd.type_id
		LEFT JOIN LATERAL (SELECT a.id, a.active FROM actions a WHERE a.target_id = t.id
		                   ORDER BY a.id DESC LIMIT 1) la ON true
		WHERE t.tenant = $1 AND t.controller_id = ANY($2)`, s.tenant, ids)
	if err != nil {
		return nil, err
	}
	byAction := map[int64]*TargetState{}
	var aids []int64
	for rows.Next() {
		st := &TargetState{Statuses: []model.ActionStatus{}, Downloads: []model.Download{}}
		var aID, iID *int64
		var aN, aV, aT, iN, iV, iT *string
		if err := rows.Scan(&st.ControllerID, &st.DSType, &st.ActionID, &st.Active,
			&aID, &aN, &aV, &aT, &iID, &iN, &iV, &iT, &st.Fleet, &st.FleetColour); err != nil {
			rows.Close()
			return nil, err
		}
		ref := func(id *int64, n, v, t *string) *SetRef {
			if id == nil {
				return nil
			}
			r := &SetRef{ID: *id}
			if n != nil {
				r.Name = *n
			}
			if v != nil {
				r.Version = *v
			}
			if t != nil {
				r.Type = *t
			}
			return r
		}
		st.Assigned, st.Installed = ref(aID, aN, aV, aT), ref(iID, iN, iV, iT)
		out[st.ControllerID] = st
		if st.ActionID != nil {
			byAction[*st.ActionID] = st
			aids = append(aids, *st.ActionID)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil || len(aids) == 0 {
		return out, err
	}

	rows, err = s.pool.Query(ctx, `
		SELECT id, action_id, status, occurred_at, reported_at, code, messages FROM (
			SELECT s.*, row_number() OVER (PARTITION BY s.action_id ORDER BY s.id DESC) AS n
			FROM action_status s WHERE s.action_id = ANY($1)) x
		WHERE n <= $2 ORDER BY action_id, id DESC`, aids, keep)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var st model.ActionStatus
		if err := rows.Scan(&st.ID, &st.ActionID, &st.Status, &st.OccurredAt, &st.ReportedAt, &st.Code, &st.Messages); err != nil {
			rows.Close()
			return nil, err
		}
		if t := byAction[st.ActionID]; t != nil {
			t.Statuses = append(t.Statuses, st)
		}
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	rows, err = s.pool.Query(ctx, "SELECT "+downloadCols+" FROM "+downloadFrom+
		" WHERE a.tenant = $1 AND d.action_id = ANY($2) ORDER BY d.action_id, d.artifact_id", s.tenant, aids)
	if err != nil {
		return nil, err
	}
	dls, err := scanDownloads(rows)
	if err != nil {
		return nil, err
	}
	for _, d := range dls {
		if t := byAction[d.ActionID]; t != nil {
			t.Downloads = append(t.Downloads, d)
		}
	}
	return out, nil
}

// AttributesOfMany reads the attributes of these targets.
func (s *Store) AttributesOfMany(ctx context.Context, ids []string) (map[string]map[string]string, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT t.controller_id, ta.attr_key, ta.attr_value
		FROM target_attributes ta JOIN targets t ON t.id = ta.target_id
		WHERE t.tenant = $1 AND t.controller_id = ANY($2)`, s.tenant, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]map[string]string{}
	for rows.Next() {
		var c, k, v string
		if err := rows.Scan(&c, &k, &v); err != nil {
			return nil, err
		}
		if out[c] == nil {
			out[c] = map[string]string{}
		}
		out[c][k] = v
	}
	return out, rows.Err()
}

// DeploymentGroup counts the open actions of one set, one rollout (or none)
// and one fleet (or none), by what the devices are doing.
type DeploymentGroup struct {
	DSID        int64
	DSLabel     string
	DSType      string
	RolloutID   *int64
	FleetID     *int64
	Open        int64
	Scheduled   int64 // waiting for their maintenance window
	Downloading int64 // a download under way
	Installing  int64 // every byte delivered, no report yet
	Confirming  int64 // waiting for someone to allow it on the device
	Canceling   int64
	Since       int64
	By          []string
}

// ActiveDeployments groups every open action, in one query.
func (s *Store) ActiveDeployments(ctx context.Context) ([]DeploymentGroup, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.ds_id,
		       (SELECT x.name || ':' || x.version FROM distribution_sets x WHERE x.id = a.ds_id),
		       coalesce((SELECT y.type_key FROM distribution_sets x JOIN ds_types y ON y.id = x.type_id
		                 WHERE x.id = a.ds_id), ''),
		       a.rollout_id, t.fleet_id,
		       count(*),
		       count(*) FILTER (WHERE a.status = 'scheduled'),
		       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM action_downloads d
		                                      WHERE d.action_id = a.id AND d.completed_at IS NULL)),
		       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM action_downloads d WHERE d.action_id = a.id)
		                          AND NOT EXISTS (SELECT 1 FROM action_downloads d
		                                          WHERE d.action_id = a.id AND d.completed_at IS NULL)),
		       count(*) FILTER (WHERE a.status = 'wait_for_confirmation'),
		       count(*) FILTER (WHERE a.status = 'canceling'),
		       min(a.created_at),
		       array_agg(DISTINCT a.initiated_by)
		FROM actions a JOIN targets t ON t.id = a.target_id
		WHERE a.tenant = $1 AND a.active
		GROUP BY a.ds_id, a.rollout_id, t.fleet_id`, s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []DeploymentGroup{}
	for rows.Next() {
		var g DeploymentGroup
		if err := rows.Scan(&g.DSID, &g.DSLabel, &g.DSType, &g.RolloutID, &g.FleetID, &g.Open, &g.Scheduled,
			&g.Downloading, &g.Installing, &g.Confirming, &g.Canceling, &g.Since, &g.By); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}
