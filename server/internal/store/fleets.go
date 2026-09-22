package store

import (
	"context"
	"errors"
	"strconv"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Fleets and their releases (a Qawk addition).

const fleetCols = `f.id, f.name, f.description, f.colour, f.rule, f.ds_id,
	(SELECT x.name || ':' || x.version FROM distribution_sets x WHERE x.id = f.ds_id), f.action_type,
	f.upstream_id, (SELECT u.name FROM fleets u WHERE u.id = f.upstream_id), f.temporary, f.auto_promote,
	f.gate_min_devices, f.gate_min_success, f.gate_soak_minutes, f.approval_required,
	f.wave_percent, f.wave_timeout_minutes, f.error_threshold,
	f.freeze_reason, f.freeze_from, f.freeze_until,
	f.manifest_id, (SELECT m.name FROM manifests m WHERE m.id = f.manifest_id),
	f.orch_max_parallel, f.orch_max_failed, f.orch_by_centre, f.orch_centres,
	f.created_at, f.created_by, f.last_modified_at, f.last_modified_by,
	(SELECT count(*) FROM targets t WHERE t.fleet_id = f.id),
	(SELECT count(*) FROM targets t WHERE t.fleet_id = f.id AND f.ds_id IS NOT NULL AND t.installed_ds_id = f.ds_id),
	(SELECT count(*) FROM targets t WHERE t.fleet_id = f.id AND EXISTS (SELECT 1 FROM actions a WHERE a.target_id = t.id AND a.active)),
	(SELECT count(*) FROM targets t WHERE t.fleet_id = f.id AND t.update_status = 'error'),
	(SELECT count(*) FROM system_members sm JOIN targets t ON t.id = sm.target_id WHERE t.fleet_id = f.id)`

func scanFleet(r pgx.Row) (model.Fleet, error) {
	var f model.Fleet
	err := r.Scan(&f.ID, &f.Name, &f.Description, &f.Colour, &f.Rule, &f.DSID, &f.DSLabel, &f.ActionType,
		&f.UpstreamID, &f.UpstreamName, &f.Temporary, &f.AutoPromote,
		&f.Gate.MinDevices, &f.Gate.MinSuccess, &f.Gate.SoakMinutes, &f.Gate.ApprovalRequired,
		&f.WavePercent, &f.WaveTimeoutMinutes, &f.ErrorThreshold,
		&f.FreezeReason, &f.FreezeFrom, &f.FreezeUntil,
		&f.ManifestID, &f.ManifestLabel, &f.Orchestrator.MaxParallel, &f.Orchestrator.MaxFailed, &f.Orchestrator.ByCentre,
		&f.Orchestrator.Centres,
		&f.CreatedAt, &f.CreatedBy, &f.LastModifiedAt, &f.LastModifiedBy,
		&f.Members, &f.OnRelease, &f.Updating, &f.Failed, &f.InSystems)
	return f, err
}

func (s *Store) Fleets(ctx context.Context) ([]model.Fleet, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+fleetCols+" FROM fleets f WHERE f.tenant = $1 ORDER BY f.name", s.tenant)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.Fleet{}
	for rows.Next() {
		f, err := scanFleet(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

func (s *Store) Fleet(ctx context.Context, q Q, id int64) (model.Fleet, error) {
	f, err := scanFleet(q.QueryRow(ctx, "SELECT "+fleetCols+" FROM fleets f WHERE f.tenant = $1 AND f.id = $2", s.tenant, id))
	return f, notFound(err, "Fleet", id)
}

// CreateFleet stores a fleet's settings; its release is set with SetFleetDS.
func (s *Store) CreateFleet(ctx context.Context, tx pgx.Tx, user string, now int64, f model.Fleet) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO fleets (tenant, name, description, colour, rule, action_type,
		                    upstream_id, temporary, gate_min_devices, gate_min_success, gate_soak_minutes,
		                    approval_required, wave_percent, wave_timeout_minutes, error_threshold,
		                    created_at, created_by, last_modified_at, last_modified_by, auto_promote,
		                    orch_max_parallel, orch_max_failed, orch_by_centre, orch_centres)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $16, $17, $18,
		        $19, $20, $21, $22)
		RETURNING id`,
		s.tenant, f.Name, f.Description, f.Colour, f.Rule, f.ActionType,
		f.UpstreamID, f.Temporary, f.Gate.MinDevices, f.Gate.MinSuccess, f.Gate.SoakMinutes,
		f.Gate.ApprovalRequired, f.WavePercent, f.WaveTimeoutMinutes, f.ErrorThreshold, now, user,
		f.AutoPromote, f.Orchestrator.MaxParallel, f.Orchestrator.MaxFailed, f.Orchestrator.ByCentre,
		f.Orchestrator.Centres).Scan(&id)
	return id, err
}

func (s *Store) UpdateFleet(ctx context.Context, tx pgx.Tx, user string, now int64, f model.Fleet) error {
	_, err := tx.Exec(ctx, `
		UPDATE fleets SET name = $3, description = $4, colour = $5, rule = $6, action_type = $7,
		       upstream_id = $8, temporary = $9, gate_min_devices = $10, gate_min_success = $11,
		       gate_soak_minutes = $12, approval_required = $13, wave_percent = $14,
		       wave_timeout_minutes = $15, error_threshold = $16,
		       last_modified_at = $17, last_modified_by = $18, auto_promote = $19,
		       orch_max_parallel = $20, orch_max_failed = $21, orch_by_centre = $22, orch_centres = $23
		WHERE tenant = $1 AND id = $2`,
		s.tenant, f.ID, f.Name, f.Description, f.Colour, f.Rule, f.ActionType,
		f.UpstreamID, f.Temporary, f.Gate.MinDevices, f.Gate.MinSuccess,
		f.Gate.SoakMinutes, f.Gate.ApprovalRequired, f.WavePercent,
		f.WaveTimeoutMinutes, f.ErrorThreshold, now, user, f.AutoPromote,
		f.Orchestrator.MaxParallel, f.Orchestrator.MaxFailed, f.Orchestrator.ByCentre, f.Orchestrator.Centres)
	return err
}

// SetFleetManifest sets the manifest of the release a fleet runs (nil: none).
func (s *Store) SetFleetManifest(ctx context.Context, tx pgx.Tx, id int64, m *int64) error {
	_, err := tx.Exec(ctx, `UPDATE fleets SET manifest_id = $3 WHERE tenant = $1 AND id = $2`, s.tenant, id, m)
	return err
}

// SetFleetDS sets the release a fleet runs (nil: none).
func (s *Store) SetFleetDS(ctx context.Context, tx pgx.Tx, user string, now int64, id int64, ds *int64) error {
	_, err := tx.Exec(ctx, `UPDATE fleets SET ds_id = $3, last_modified_at = $4, last_modified_by = $5
		WHERE tenant = $1 AND id = $2`, s.tenant, id, ds, now, user)
	return err
}

// SetFreeze freezes a fleet (reason set) or thaws it (reason nil).
func (s *Store) SetFreeze(ctx context.Context, tx pgx.Tx, user string, now int64, id int64, reason *string, from, until *int64) error {
	_, err := tx.Exec(ctx, `UPDATE fleets SET freeze_reason = $3, freeze_from = $4, freeze_until = $5,
		last_modified_at = $6, last_modified_by = $7 WHERE tenant = $1 AND id = $2`,
		s.tenant, id, reason, from, until, now, user)
	return err
}

func (s *Store) DeleteFleet(ctx context.Context, tx pgx.Tx, id int64) error {
	_, err := tx.Exec(ctx, `DELETE FROM fleets WHERE tenant = $1 AND id = $2`, s.tenant, id)
	return err
}

// SetFleet puts targets in a fleet, or takes them out of theirs (nil). Into a
// temporary fleet they remember the fleet they came from, to go back to it.
func (s *Store) SetFleet(ctx context.Context, tx pgx.Tx, ids []int64, fleet *int64, now int64, rememberHome bool) error {
	_, err := tx.Exec(ctx, `
		UPDATE targets SET
		       home_fleet_id = CASE WHEN $4 THEN coalesce(home_fleet_id, fleet_id) ELSE NULL END,
		       fleet_id = $3, fleet_joined_at = $5
		WHERE tenant = $1 AND id = ANY($2) AND fleet_id IS DISTINCT FROM $3::bigint`,
		s.tenant, ids, fleet, rememberHome, now)
	return err
}

// ReturnHome sends a temporary fleet's members back where they came from:
// all of them, or those in ids. It says how many went, and how many had no
// home to go to (they stay).
func (s *Store) ReturnHome(ctx context.Context, tx pgx.Tx, fleet int64, ids []int64, now int64) (int64, int64, error) {
	tag, err := tx.Exec(ctx, `
		UPDATE targets SET fleet_id = home_fleet_id, home_fleet_id = NULL, fleet_joined_at = $3
		WHERE tenant = $1 AND fleet_id = $2 AND home_fleet_id IS NOT NULL
		  AND ($4::bigint[] IS NULL OR id = ANY($4))`, s.tenant, fleet, now, ids)
	if err != nil {
		return 0, 0, err
	}
	var homeless int64
	err = tx.QueryRow(ctx, `SELECT count(*) FROM targets WHERE tenant = $1 AND fleet_id = $2
		AND ($3::bigint[] IS NULL OR id = ANY($3))`, s.tenant, fleet, ids).Scan(&homeless)
	return tag.RowsAffected(), homeless, err
}

// FleetMembers lists a fleet's members with what they run and should run.
func (s *Store) FleetMembers(ctx context.Context, fleet int64, p httpx.Page) ([]model.FleetMember, int64, error) {
	var total int64
	if err := s.pool.QueryRow(ctx, `SELECT count(*) FROM targets WHERE tenant = $1 AND fleet_id = $2`,
		s.tenant, fleet).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.pool.Query(ctx, `
		SELECT t.controller_id, t.name, t.update_status,
		       (SELECT x.name || ':' || x.version FROM distribution_sets x WHERE x.id = t.installed_ds_id),
		       (SELECT x.name || ':' || x.version FROM distribution_sets x WHERE x.id = t.assigned_ds_id),
		       t.last_request_at, t.fleet_joined_at,
		       (SELECT h.name FROM fleets h WHERE h.id = t.home_fleet_id)
		FROM targets t WHERE t.tenant = $1 AND t.fleet_id = $2
		ORDER BY t.controller_id LIMIT `+strconv.Itoa(p.Limit)+` OFFSET `+strconv.Itoa(p.Offset),
		s.tenant, fleet)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := []model.FleetMember{}
	for rows.Next() {
		var m model.FleetMember
		if err := rows.Scan(&m.ControllerID, &m.Name, &m.UpdateStatus, &m.Installed, &m.Assigned,
			&m.LastRequestAt, &m.JoinedAt, &m.Home); err != nil {
			return nil, 0, err
		}
		out = append(out, m)
	}
	return out, total, rows.Err()
}

// InFleet is the condition "a member of this fleet", for target lists.
func InFleet(id int64) func(a *Args) []string {
	return func(a *Args) []string { return []string{"t.fleet_id = " + a.Bind(id)} }
}

// Progress counts how a fleet's release ds is going since it started. The
// members that are part of a system are not counted: system deployments
// update them, the release never reaches them, and a gate or a wave counted
// over them would never open, or never end.
func (s *Store) Progress(ctx context.Context, fleet, ds, since int64) (model.ReleaseProgress, error) {
	var p model.ReleaseProgress
	err := s.pool.QueryRow(ctx, `
		SELECT count(*),
		       count(*) FILTER (WHERE t.installed_ds_id = $3),
		       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM actions a
		                        WHERE a.target_id = t.id AND a.ds_id = $3 AND a.active)),
		       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM actions a WHERE a.target_id = t.id
		                        AND a.ds_id = $3 AND a.status = 'finished' AND a.created_at >= $4)),
		       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM actions a WHERE a.target_id = t.id
		                        AND a.ds_id = $3 AND a.status = 'error' AND a.created_at >= $4)
		                    AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.target_id = t.id
		                        AND a.ds_id = $3 AND a.status = 'finished' AND a.created_at >= $4))
		FROM targets t WHERE t.tenant = $1 AND t.fleet_id = $2
		  AND NOT EXISTS (SELECT 1 FROM system_members sm WHERE sm.target_id = t.id)`,
		s.tenant, fleet, ds, since).Scan(&p.Members, &p.OnRelease, &p.Active, &p.Succeeded, &p.Failed)
	return p, err
}

// ------------------------------------------------------------------ releases

const releaseCols = `r.id, r.fleet_id, (SELECT f.name FROM fleets f WHERE f.id = r.fleet_id),
	r.ds_id, r.ds_label, r.from_fleet_id, r.from_fleet_name, r.status, r.forced, r.reason, r.gate_report,
	r.requested_by, r.requested_at, r.decided_by, r.decided_at, r.started_at, r.finished_at,
	r.waves, r.last_wave_at, r.failure_baseline, r.manifest_id, r.manifest_label, r.system_deployment_id`

func scanRelease(row pgx.Row) (model.FleetRelease, error) {
	var r model.FleetRelease
	err := row.Scan(&r.ID, &r.FleetID, &r.FleetName, &r.DSID, &r.DSLabel, &r.FromFleetID, &r.FromFleetName,
		&r.Status, &r.Forced, &r.Reason, &r.GateReport, &r.RequestedBy, &r.RequestedAt,
		&r.DecidedBy, &r.DecidedAt, &r.StartedAt, &r.FinishedAt, &r.Waves, &r.LastWaveAt, &r.FailureBaseline,
		&r.ManifestID, &r.ManifestLabel, &r.SystemDeploymentID)
	return r, err
}

func (s *Store) CreateRelease(ctx context.Context, tx pgx.Tx, r model.FleetRelease) (int64, error) {
	var id int64
	err := tx.QueryRow(ctx, `
		INSERT INTO fleet_releases (tenant, fleet_id, ds_id, ds_label, from_fleet_id, from_fleet_name,
		                            status, forced, reason, gate_report, requested_by, requested_at,
		                            manifest_id, manifest_label)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
		s.tenant, r.FleetID, r.DSID, r.DSLabel, r.FromFleetID, r.FromFleetName,
		r.Status, r.Forced, r.Reason, r.GateReport, r.RequestedBy, r.RequestedAt, r.ManifestID, r.ManifestLabel).Scan(&id)
	return id, err
}

func (s *Store) Release(ctx context.Context, q Q, id int64) (model.FleetRelease, error) {
	r, err := scanRelease(q.QueryRow(ctx, "SELECT "+releaseCols+" FROM fleet_releases r WHERE r.tenant = $1 AND r.id = $2",
		s.tenant, id))
	return r, notFound(err, "Release", id)
}

func (s *Store) oneRelease(ctx context.Context, q Q, fleet int64, statuses []string) (*model.FleetRelease, error) {
	r, err := scanRelease(q.QueryRow(ctx, "SELECT "+releaseCols+" FROM fleet_releases r "+
		"WHERE r.tenant = $1 AND r.fleet_id = $2 AND r.status = ANY($3) ORDER BY r.id DESC LIMIT 1",
		s.tenant, fleet, statuses))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// CurrentRelease is the release a fleet is delivering or has delivered.
func (s *Store) CurrentRelease(ctx context.Context, q Q, fleet int64) (*model.FleetRelease, error) {
	return s.oneRelease(ctx, q, fleet, []string{model.ReleaseActive, model.ReleaseHalted, model.ReleaseCompleted})
}

// PendingRelease is the latest release of a fleet waiting for approval.
func (s *Store) PendingRelease(ctx context.Context, q Q, fleet int64) (*model.FleetRelease, error) {
	return s.oneRelease(ctx, q, fleet, []string{model.ReleasePending})
}

// Releases lists releases, newest first: of one fleet (0: all), in one
// status ("": any).
func (s *Store) Releases(ctx context.Context, fleet int64, status string, limit int) ([]model.FleetRelease, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+releaseCols+" FROM fleet_releases r WHERE r.tenant = $1 "+
		"AND ($2 = 0 OR r.fleet_id = $2) AND ($3 = '' OR r.status = $3) ORDER BY r.id DESC LIMIT "+strconv.Itoa(limit),
		s.tenant, fleet, status)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []model.FleetRelease{}
	for rows.Next() {
		r, err := scanRelease(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// StartRelease makes a release the fleet's current one: the one it had
// before is superseded.
func (s *Store) StartRelease(ctx context.Context, tx pgx.Tx, fleet, id, now int64) error {
	if _, err := tx.Exec(ctx, `UPDATE fleet_releases SET status = $4, finished_at = $5
		WHERE tenant = $1 AND fleet_id = $2 AND id <> $3 AND status = ANY($6)`,
		s.tenant, fleet, id, model.ReleaseSuperseded, now,
		[]string{model.ReleaseActive, model.ReleaseHalted, model.ReleaseCompleted}); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE fleet_releases SET status = $3, started_at = $4 WHERE tenant = $1 AND id = $2`,
		s.tenant, id, model.ReleaseActive, now)
	return err
}

// EndReleases supersedes a fleet's current release, when it is given none.
func (s *Store) EndReleases(ctx context.Context, tx pgx.Tx, fleet, now int64) error {
	_, err := tx.Exec(ctx, `UPDATE fleet_releases SET status = $3, finished_at = $4
		WHERE tenant = $1 AND fleet_id = $2 AND status = ANY($5)`,
		s.tenant, fleet, model.ReleaseSuperseded, now,
		[]string{model.ReleaseActive, model.ReleaseHalted, model.ReleaseCompleted})
	return err
}

// DecideRelease records an approval's answer.
func (s *Store) DecideRelease(ctx context.Context, tx pgx.Tx, id int64, status, user, note string, now int64) error {
	_, err := tx.Exec(ctx, `UPDATE fleet_releases SET status = $3, decided_by = $4, decided_at = $5,
		reason = CASE WHEN $6 = '' THEN reason WHEN reason = '' THEN $6 ELSE reason || E'\n' || $6 END
		WHERE tenant = $1 AND id = $2`, s.tenant, id, status, user, now, note)
	return err
}

func (s *Store) HaltRelease(ctx context.Context, id int64, why string, now int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE fleet_releases SET status = $3,
		reason = CASE WHEN reason = '' THEN $4 ELSE reason || E'\n' || $4 END
		WHERE tenant = $1 AND id = $2`, s.tenant, id, model.ReleaseHalted, why)
	return err
}

func (s *Store) ResumeRelease(ctx context.Context, tx pgx.Tx, id int64, baseline int64) error {
	_, err := tx.Exec(ctx, `UPDATE fleet_releases SET status = $3, failure_baseline = $4
		WHERE tenant = $1 AND id = $2`, s.tenant, id, model.ReleaseActive, baseline)
	return err
}

func (s *Store) CompleteRelease(ctx context.Context, id, now int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE fleet_releases SET status = $3, finished_at = $4 WHERE tenant = $1 AND id = $2`,
		s.tenant, id, model.ReleaseCompleted, now)
	return err
}

// ReopenRelease puts a completed release back to active: devices joined its
// fleet after it had reached everyone, and it is going to them too. Only a
// completed one: a halted release stays halted until someone decides.
func (s *Store) ReopenRelease(ctx context.Context, id int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE fleet_releases SET status = $3, finished_at = NULL
		WHERE tenant = $1 AND id = $2 AND status = $4`, s.tenant, id, model.ReleaseActive, model.ReleaseCompleted)
	return err
}

func (s *Store) MarkWave(ctx context.Context, id, now int64) error {
	_, err := s.pool.Exec(ctx, `UPDATE fleet_releases SET waves = waves + 1, last_wave_at = $3 WHERE tenant = $1 AND id = $2`,
		s.tenant, id, now)
	return err
}

// SetReleaseSystemDeployment records the system deployment a release started.
func (s *Store) SetReleaseSystemDeployment(ctx context.Context, q Q, id, sd int64) error {
	_, err := q.Exec(ctx, `UPDATE fleet_releases SET system_deployment_id = $3 WHERE tenant = $1 AND id = $2`,
		s.tenant, id, sd)
	return err
}

// EndReleaseDeployments stops what the orchestrator was still doing for a
// fleet's other releases: the release that supersedes them supersedes their
// systems' updates too. The systems not started are skipped; one being
// updated finishes its stage.
func (s *Store) EndReleaseDeployments(ctx context.Context, tx pgx.Tx, fleet, keep int64, why string, now int64) error {
	of := `SELECT r.system_deployment_id FROM fleet_releases r WHERE r.tenant = $1 AND r.fleet_id = $2
		AND r.id <> $3 AND r.system_deployment_id IS NOT NULL`
	if _, err := tx.Exec(ctx, `UPDATE system_runs SET status = 'skipped', reason = $4
		WHERE status = 'pending' AND deployment_id IN (`+of+`)`, s.tenant, fleet, keep, why); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `UPDATE system_deployments SET status = 'aborted', reason = $4, finished_at = $5
		WHERE tenant = $1 AND status IN ('draft', 'running', 'paused') AND id IN (`+of+`)`,
		s.tenant, fleet, keep, why, now)
	return err
}
