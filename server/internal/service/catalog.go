// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package service

import (
	"context"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// The catalogue: modules, their artifacts, sets and what goes in them. Most
// of it is plain storage; the rules live here.

// Tx runs a plain change -- one without rules of its own, like renaming a
// tag -- in one transaction. The operations with rules have methods.
func (s *Service) Tx(ctx context.Context, user string, fn func(tx pgx.Tx, now int64) error) error {
	return s.st.Tx(ctx, user, fn)
}

// UploadArtifact stores a file and attaches it to a module.
//
// The bytes are written to the store first, hashed on the way, and checked
// against the hashes the client says it sent: an upload that arrived damaged
// is refused rather than handed to a thousand devices. A module in a locked
// set takes no new files, or what a device installs would stop matching what
// was assigned.
func (s *Service) UploadArtifact(ctx context.Context, user string, smID int64, filename string, body io.Reader,
	wantMD5, wantSHA1, wantSHA256 string) (model.Artifact, error) {

	m, err := s.st.SoftwareModule(ctx, s.st.DB(), smID)
	if err != nil {
		return model.Artifact{}, err
	}
	if m.Deleted {
		return model.Artifact{}, httpx.NotFound("SoftwareModule", smID)
	}
	if locked, err := s.st.InUseByLockedSet(ctx, s.st.DB(), smID); err != nil {
		return model.Artifact{}, err
	} else if locked {
		return model.Artifact{}, errLocked("SoftwareModule", smID)
	}
	sums, err := s.art.Put(body)
	if err != nil {
		return model.Artifact{}, err
	}
	for _, c := range []struct{ name, want, got string }{
		{"MD5", wantMD5, sums.MD5}, {"SHA1", wantSHA1, sums.SHA1}, {"SHA256", wantSHA256, sums.SHA256},
	} {
		if c.want != "" && !strings.EqualFold(c.want, c.got) {
			s.gc(ctx, sums.SHA256)
			return model.Artifact{}, httpx.Custom(400, "hawkbit.server.error.artifact.uploadFailed.checksum."+
				strings.ToLower(c.name)+".match", "org.eclipse.hawkbit.repository.exception.InvalidMD5HashException",
				fmt.Sprintf("The given %s hash %s does not match the uploaded file's %s", c.name, c.want, c.got))
		}
	}
	var art model.Artifact
	err = s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if _, err := s.st.ArtifactByName(ctx, tx, smID, filename); err == nil {
			return httpx.AlreadyExists(fmt.Sprintf("An artifact named %s already exists in this module", filename))
		}
		id, err := s.st.CreateArtifact(ctx, tx, user, now, model.Artifact{SMID: smID, Filename: filename,
			SHA1: sums.SHA1, MD5: sums.MD5, SHA256: sums.SHA256, Size: sums.Size})
		if err != nil {
			return err
		}
		art, err = s.st.Artifact(ctx, tx, smID, id)
		return err
	})
	if err != nil {
		s.gc(ctx, sums.SHA256)
	}
	return art, err
}

// gc removes stored bytes that no artifact points at any more.
func (s *Service) gc(ctx context.Context, sha string) {
	if used, err := s.st.HashInUse(ctx, s.st.DB(), sha); err == nil && !used {
		if err := s.art.Delete(sha); err != nil {
			s.log.Warn("removing artifact bytes", "sha256", sha, "err", err)
		}
	}
}

func (s *Service) DeleteArtifact(ctx context.Context, user string, smID, artID int64) error {
	var sha string
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if locked, err := s.st.InUseByLockedSet(ctx, tx, smID); err != nil {
			return err
		} else if locked {
			return errLocked("SoftwareModule", smID)
		}
		var err error
		sha, err = s.st.DeleteArtifact(ctx, tx, smID, artID)
		return err
	})
	if err == nil {
		s.gc(ctx, sha)
	}
	return err
}

func (s *Service) DeleteModule(ctx context.Context, user string, smID int64) error {
	var hashes []string
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		if _, err := s.st.SoftwareModule(ctx, tx, smID); err != nil {
			return err
		}
		var err error
		hashes, err = s.st.DeleteSM(ctx, tx, user, now, smID)
		return err
	})
	for _, h := range hashes {
		s.gc(ctx, h)
	}
	return err
}

// AddModules puts modules into a set. A locked set is closed; a module type
// can only go into a set whose type allows it, and no more of them than the
// module type's maxAssignments (one OS per set).
func (s *Service) AddModules(ctx context.Context, user string, dsID int64, smIDs []int64) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		ds, err := s.st.DistributionSet(ctx, tx, dsID)
		if err != nil {
			return err
		}
		if ds.Locked {
			return errLocked("DistributionSet", dsID)
		}
		return s.addModulesTx(ctx, tx, ds, smIDs)
	})
}

func (s *Service) addModulesTx(ctx context.Context, tx pgx.Tx, ds model.DistributionSet, smIDs []int64) error {
	allowed := map[int64]bool{}
	for _, mandatory := range []bool{true, false} {
		types, err := s.st.DSTypeModuleTypes(ctx, tx, ds.TypeID, mandatory)
		if err != nil {
			return err
		}
		for _, t := range types {
			allowed[t.ID] = true
		}
	}
	count := map[int64]int{}
	have := map[int64]bool{}
	for _, m := range ds.Modules {
		count[m.TypeID]++
		have[m.ID] = true
	}
	for _, id := range smIDs {
		if have[id] {
			continue
		}
		m, err := s.st.SoftwareModule(ctx, tx, id)
		if err != nil {
			return err
		}
		if m.Deleted {
			return httpx.NotFound("SoftwareModule", id)
		}
		if !allowed[m.TypeID] {
			return httpx.Custom(400, "hawkbit.server.error.distributionset.type.undefined",
				repoExc+"UnsupportedSoftwareModuleForThisDistributionSetException",
				fmt.Sprintf("A set of type %s cannot contain a module of type %s", ds.TypeName, m.TypeName))
		}
		t, err := s.st.SMType(ctx, tx, m.TypeID)
		if err != nil {
			return err
		}
		count[m.TypeID]++
		if count[m.TypeID] > t.MaxAssignments {
			return errQuota(fmt.Sprintf("A set can contain at most %d module(s) of type %s", t.MaxAssignments, t.Name))
		}
		if err := s.st.AddModule(ctx, tx, ds.ID, id); err != nil {
			return err
		}
		have[id] = true
	}
	return nil
}

// SetDef is a distribution set to create.
type SetDef struct {
	Name                  string
	Version               string
	TypeKey               string // empty: the tenant's default.ds.type
	Description           string
	RequiredMigrationStep bool
	Modules               []int64
}

// CreateSet creates a set and puts its modules in, in one transaction: a
// set that cannot hold the modules it was created with is not created.
func (s *Service) CreateSet(ctx context.Context, user string, d SetDef) (int64, error) {
	if strings.TrimSpace(d.Name) == "" || strings.TrimSpace(d.Version) == "" {
		return 0, httpx.Validation("a distribution set needs a name and a version")
	}
	var id int64
	err := s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		var t model.DSType
		var err error
		if d.TypeKey != "" {
			t, err = s.st.DSTypeByKey(ctx, tx, d.TypeKey)
		} else {
			t, err = s.st.DSType(ctx, tx, s.st.ConfigInt(ctx, "default.ds.type"))
		}
		if err != nil {
			return err
		}
		id, err = s.st.CreateDS(ctx, tx, user, now, model.DistributionSet{TypeID: t.ID, Name: d.Name, Version: d.Version,
			Description: d.Description, RequiredMigrationStep: d.RequiredMigrationStep})
		if err != nil {
			return err
		}
		ds, err := s.st.DistributionSet(ctx, tx, id)
		if err != nil {
			return err
		}
		return s.addModulesTx(ctx, tx, ds, d.Modules)
	})
	return id, err
}

func (s *Service) RemoveModule(ctx context.Context, user string, dsID, smID int64) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		ds, err := s.st.DistributionSet(ctx, tx, dsID)
		if err != nil {
			return err
		}
		if ds.Locked {
			return errLocked("DistributionSet", dsID)
		}
		if removed, err := s.st.RemoveModule(ctx, tx, dsID, smID); err != nil {
			return err
		} else if !removed {
			return httpx.NotFound("SoftwareModule", smID)
		}
		return nil
	})
}

// OfflineInstalled records that a device already runs a set it installed some
// other way: the set is assigned and installed, with a finished action, as
// hawkBit's "set offline assigned version" does.
func (s *Service) OfflineInstalled(ctx context.Context, t model.Target, name, version string) (int64, error) {
	var id int64
	err := s.st.Tx(ctx, t.ControllerID, func(tx pgx.Tx, now int64) error {
		var dsID int64
		if err := tx.QueryRow(ctx, `SELECT id FROM distribution_sets WHERE tenant = $1 AND name = $2 AND version = $3
			AND NOT deleted`, s.st.Tenant(), name, version).Scan(&dsID); err != nil {
			return httpx.NotFound("DistributionSet", name+":"+version)
		}
		t, err := s.st.TargetForUpdate(ctx, tx, t.ControllerID)
		if err != nil {
			return err
		}
		w := DefaultWeight
		id, err = s.st.CreateAction(ctx, tx, t.ControllerID, now, model.Action{TargetID: t.ID, DSID: dsID,
			ActionType: model.TypeForced, Status: model.StatusFinished, Weight: &w, InitiatedBy: t.ControllerID})
		if err != nil {
			return err
		}
		if err := s.st.SetAction(ctx, tx, id, model.StatusFinished, false, nil, t.ControllerID, now); err != nil {
			return err
		}
		if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: id, Status: model.StatusFinished,
			OccurredAt: now, ReportedAt: now, Messages: []string{"Update Server: installed offline"}}); err != nil {
			return err
		}
		return s.st.SetState(ctx, tx, t.ID, &dsID, &dsID, &now, model.UpdateInSync)
	})
	return id, err
}
