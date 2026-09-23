// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package store

import (
	"context"

	"github.com/jackc/pgx/v5"

	"qawk/internal/model"
)

// Download progress, per action and artifact (a Qawk addition).

// StartDownload records that a download of an artifact for an action has
// begun. A download that starts again from the beginning -- a device that
// retries -- starts the count again; a range of a delta adds to it.
func (s *Store) StartDownload(ctx context.Context, q Q, actionID, artifactID, size int64, ranged, fromStart bool, now int64) error {
	if fromStart && !ranged {
		_, err := q.Exec(ctx, `
			INSERT INTO action_downloads (action_id, artifact_id, size, bytes, ranged, started_at, updated_at)
			VALUES ($1, $2, $3, 0, FALSE, $4, $4)
			ON CONFLICT (action_id, artifact_id) DO UPDATE
			SET bytes = 0, ranged = FALSE, started_at = $4, updated_at = $4, completed_at = NULL`,
			actionID, artifactID, size, now)
		return err
	}
	_, err := q.Exec(ctx, `
		INSERT INTO action_downloads (action_id, artifact_id, size, bytes, ranged, started_at, updated_at)
		VALUES ($1, $2, $3, 0, $4, $5, $5)
		ON CONFLICT (action_id, artifact_id) DO UPDATE SET ranged = action_downloads.ranged OR $4, updated_at = $5`,
		actionID, artifactID, size, ranged, now)
	return err
}

// Downloaded adds bytes to a download, and marks it complete when told to.
func (s *Store) Downloaded(ctx context.Context, q Q, actionID, artifactID, n int64, complete bool, now int64) error {
	_, err := q.Exec(ctx, `
		UPDATE action_downloads SET bytes = LEAST(size, bytes + $3), updated_at = $4,
		       completed_at = CASE WHEN $5 THEN $4 ELSE completed_at END
		WHERE action_id = $1 AND artifact_id = $2`, actionID, artifactID, n, now, complete)
	return err
}

const downloadCols = `d.action_id, t.controller_id, d.artifact_id, ar.filename, d.size, d.bytes, d.ranged,
	d.started_at, d.updated_at, d.completed_at`

const downloadFrom = `action_downloads d JOIN actions a ON a.id = d.action_id JOIN targets t ON t.id = a.target_id
	JOIN artifacts ar ON ar.id = d.artifact_id`

func scanDownloads(rows pgx.Rows) ([]model.Download, error) {
	defer rows.Close()
	out := []model.Download{}
	for rows.Next() {
		var d model.Download
		if err := rows.Scan(&d.ActionID, &d.ControllerID, &d.ArtifactID, &d.Filename, &d.Size, &d.Bytes, &d.Ranged,
			&d.StartedAt, &d.UpdatedAt, &d.CompletedAt); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// ActiveDownloads lists the downloads of every open action: all a console
// needs to show what every device is doing, in one query.
func (s *Store) ActiveDownloads(ctx context.Context) ([]model.Download, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+downloadCols+" FROM "+downloadFrom+
		" WHERE a.tenant = $1 AND a.active ORDER BY d.action_id, d.artifact_id", s.tenant)
	if err != nil {
		return nil, err
	}
	return scanDownloads(rows)
}

// DownloadsOf lists one action's downloads, open or closed.
func (s *Store) DownloadsOf(ctx context.Context, actionID int64) ([]model.Download, error) {
	rows, err := s.pool.Query(ctx, "SELECT "+downloadCols+" FROM "+downloadFrom+
		" WHERE a.tenant = $1 AND d.action_id = $2 ORDER BY d.artifact_id", s.tenant, actionID)
	if err != nil {
		return nil, err
	}
	return scanDownloads(rows)
}
