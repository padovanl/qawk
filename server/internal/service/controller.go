package service

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/fnv"
	"strings"

	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// What happens between Qawk and a device: the DDI side of the service.

// PlugAndPlay is who creates a target that registered itself by polling.
const PlugAndPlay = "CONTROLLER_PLUG_AND_PLAY"

// Next is what a poll tells the device to do next.
type Next struct {
	Kind     string // "", "deploymentBase", "cancelAction", "confirmationBase", "installedBase"
	ActionID int64
	Hash     uint32 // deploymentBase only: changes whenever the deployment does
}

type PollResult struct {
	Target     model.Target
	Sleep      string
	Next       Next
	ConfigData bool
}

// Poll is a device's GET of its root resource. An unknown controller id
// registers a new target (plug and play), exactly as hawkBit does with a
// gateway token.
func (s *Service) Poll(ctx context.Context, controllerID string, address *string) (PollResult, error) {
	var res PollResult
	err := s.st.Tx(ctx, PlugAndPlay, func(tx pgx.Tx, now int64) error {
		// A poll writes only when the device was last seen, from where, and --
		// the first time -- that it exists. None of it is worth waiting for the
		// disk: with thousands of devices a commit that waits for its fsync is
		// a thousand fsyncs a minute, and on a busy disk every poll waited for
		// all of them (measured: 20-second stalls at 170 polls a second). Lost
		// in a crash, it is written again at the next poll. hawkBit, too,
		// writes poll times in the background. Everything else commits
		// synchronously as before.
		if _, err := tx.Exec(ctx, "SET LOCAL synchronous_commit TO OFF"); err != nil {
			return err
		}
		t, err := s.st.Target(ctx, tx, controllerID)
		var nf *httpx.Error
		if errors.As(err, &nf) && nf.Status == 404 {
			token := make([]byte, 16)
			_, _ = rand.Read(token)
			id, err := s.st.CreateTarget(ctx, tx, PlugAndPlay, now, model.Target{
				ControllerID: controllerID, Name: controllerID,
				Description:   "Plug and Play target: " + controllerID,
				SecurityToken: hex.EncodeToString(token), Address: address, LastRequestAt: &now,
				// hawkBit does not ask a target that registered itself for its
				// attributes: its first poll carries no configData link.
				// SWUpdate sends them at startup anyway.
				UpdateStatus: model.UpdateRegistered, RequestAttributes: false,
			})
			if err != nil {
				return err
			}
			t, err = s.st.TargetByID(ctx, tx, id)
			if err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else if err := s.st.Polled(ctx, tx, t.ID, now, address); err != nil {
			return err
		}
		res.Target = t
		res.ConfigData = t.RequestAttributes

		actives, err := s.st.ActiveActions(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		if len(actives) > 0 {
			a := actives[0]
			switch a.Status {
			case model.StatusCanceling:
				res.Next = Next{Kind: "cancelAction", ActionID: a.ID}
			case model.StatusWaitForConfirmation:
				res.Next = Next{Kind: "confirmationBase", ActionID: a.ID}
			default:
				res.Next = Next{Kind: "deploymentBase", ActionID: a.ID, Hash: deploymentHash(a)}
			}
		} else if last, err := s.st.LastFinished(ctx, tx, t.ID); err != nil {
			return err
		} else if last != nil {
			res.Next = Next{Kind: "installedBase", ActionID: last.ID}
		}
		return nil
	})
	res.Sleep = s.st.ConfigString(ctx, "pollingTime")
	return res, err
}

// deploymentHash is the "c" parameter of the deploymentBase link: a value
// that changes when what the device would be told changes (the action type
// going from soft to forced, say), so a device that caches by URL refetches.
func deploymentHash(a model.Action) uint32 {
	h := fnv.New32a()
	fmt.Fprintf(h, "%d/%s/%d", a.ID, a.ActionType, a.ForcedTime)
	// as hawkBit's etag: a timeforced action reaching its time is news
	if a.ActionType == model.TypeTimeForced && a.ForcedTime > 0 && httpx.Now() >= a.ForcedTime {
		h.Write([]byte("/forced"))
	}
	if a.MaintenanceSchedule != nil {
		// the window opening or closing changes what the device is told
		fmt.Fprintf(h, "/%s", MaintenanceWindow(a, httpx.Now()))
	}
	return h.Sum32() & 0x7fffffff
}

// ------------------------------------------------------------- deployment

type Chunk struct {
	Part      string
	Name      string
	Version   string
	ModuleID  int64
	Artifacts []model.Artifact
	Metadata  []model.Metadata
}

type Deployment struct {
	Action   model.Action
	Download string // skip, attempt, forced
	Update   string
	Chunks   []Chunk
	// MaintenanceWindow is "available" or "unavailable" when the action has
	// a schedule; empty otherwise.
	MaintenanceWindow string
}

// chunkPart is hawkBit's name for a module type in a deployment: the type key,
// except for two legacy names hawkBit still uses (and SWUpdate expects).
func chunkPart(typeKey string) string {
	switch typeKey {
	case "application":
		return "bApp"
	case "runtime":
		return "jvm"
	}
	return typeKey
}

// DeploymentBase is the device reading an action. The first read of an open
// action is recorded as "retrieved", as hawkBit records it; reading it again
// after it has moved on is recorded again, which is also what hawkBit does.
func (s *Service) DeploymentBase(ctx context.Context, t model.Target, actionID int64, installed bool) (Deployment, error) {
	var d Deployment
	err := s.st.Tx(ctx, t.ControllerID, func(tx pgx.Tx, now int64) error {
		a, err := s.st.ActionOf(ctx, tx, t.ID, actionID)
		if err != nil {
			return err
		}
		if installed {
			if a.Active || a.Status != model.StatusFinished {
				return httpx.NotFound("Action", actionID)
			}
		} else if a.Active && a.Status != model.StatusRetrieved && a.Status != model.StatusCanceling &&
			a.Status != model.StatusWaitForConfirmation &&
			// a device re-reading a deployment it was told to skip, window shut
			!(a.Status == model.StatusScheduled && MaintenanceWindow(a, now) == "unavailable") {
			if err := s.st.SetAction(ctx, tx, a.ID, model.StatusRetrieved, true, nil, t.ControllerID, now); err != nil {
				return err
			}
			if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: model.StatusRetrieved,
				OccurredAt: now, ReportedAt: now, Messages: []string{MsgRetrieved}}); err != nil {
				return err
			}
		}
		d.Action = a
		d.Download, d.Update = handling(a, now)
		// a maintenance window: download, but install only while it is open
		if w := MaintenanceWindow(a, now); w != "" {
			d.MaintenanceWindow = w
			if w == "unavailable" {
				d.Update = "skip"
			}
		}
		ds, err := s.st.DistributionSet(ctx, tx, a.DSID)
		if err != nil {
			return err
		}
		ids := make([]int64, len(ds.Modules))
		for i, m := range ds.Modules {
			ids[i] = m.ID
		}
		meta, err := s.st.VisibleMetadata(ctx, tx, ids)
		if err != nil {
			return err
		}
		for _, m := range ds.Modules {
			arts, err := s.st.Artifacts(ctx, tx, m.ID)
			if err != nil {
				return err
			}
			d.Chunks = append(d.Chunks, Chunk{Part: chunkPart(m.TypeKey), Name: m.Name, Version: m.Version,
				ModuleID: m.ID, Artifacts: arts, Metadata: meta[m.ID]})
		}
		return nil
	})
	return d, err
}

// handling is the "download" and "update" of a deployment.
func handling(a model.Action, now int64) (download, update string) {
	switch a.ActionType {
	case model.TypeSoft:
		return "attempt", "attempt"
	case model.TypeDownloadOnly:
		return "forced", "skip"
	case model.TypeTimeForced:
		if a.ForcedTime > 0 && now >= a.ForcedTime {
			return "forced", "forced"
		}
		return "attempt", "attempt"
	}
	return "forced", "forced"
}

// BeginDownload records a device starting to fetch an artifact of an open
// action, and returns that action (0 if the artifact belongs to none).
//
// Only the start of a download is written into the history, as hawkBit's
// "Update Server: Target downloads ..." line: a delta update reads one file in
// hundreds of ranges, and hawkBit writing an entry for each is what forced our
// start script to lift its limit on status entries.
//
// With track, the download's progress is counted too (a Qawk addition): from
// the start for a whole file, added to for a range. The .MD5SUM is not
// tracked -- fetched after the file, it would reset the count.
func (s *Service) BeginDownload(ctx context.Context, t model.Target, smID int64, art model.Artifact, path string,
	ranged, fromStart, track bool) (int64, error) {
	var actionID int64
	err := s.st.Tx(ctx, t.ControllerID, func(tx pgx.Tx, now int64) error {
		actives, err := s.st.ActiveActions(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		for _, a := range actives {
			ds, err := s.st.DistributionSet(ctx, tx, a.DSID)
			if err != nil {
				return err
			}
			for _, m := range ds.Modules {
				if m.ID != smID {
					continue
				}
				actionID = a.ID
				if fromStart {
					if err := s.st.SetAction(ctx, tx, a.ID, model.StatusDownload, true, nil, t.ControllerID, now); err != nil {
						return err
					}
					if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: model.StatusDownload,
						OccurredAt: now, ReportedAt: now, Messages: []string{MsgDownloads + path}}); err != nil {
						return err
					}
				}
				if !track {
					return nil
				}
				return s.st.StartDownload(ctx, tx, a.ID, art.ID, art.Size, ranged, fromStart, now)
			}
		}
		return nil
	})
	return actionID, err
}

// DownloadProgress adds bytes served to a download, and marks it complete:
// from that moment until the device reports, it is installing.
func (s *Service) DownloadProgress(ctx context.Context, actionID, artifactID, n int64, complete bool) error {
	return s.st.Downloaded(ctx, s.st.DB(), actionID, artifactID, n, complete, httpx.Now())
}

// ModuleOfTarget checks that the module belongs to a set the target has been
// given (open, or installed): a device downloads only what is meant for it.
func (s *Service) ModuleOfTarget(ctx context.Context, t model.Target, smID int64) (bool, error) {
	sets := map[int64]bool{}
	if t.AssignedDSID != nil {
		sets[*t.AssignedDSID] = true
	}
	if t.InstalledDSID != nil {
		sets[*t.InstalledDSID] = true
	}
	actives, err := s.st.ActiveActions(ctx, s.st.DB(), t.ID)
	if err != nil {
		return false, err
	}
	for _, a := range actives {
		sets[a.DSID] = true
	}
	for ds := range sets {
		d, err := s.st.DistributionSet(ctx, s.st.DB(), ds)
		if err != nil {
			continue
		}
		for _, m := range d.Modules {
			if m.ID == smID {
				return true, nil
			}
		}
	}
	return false, nil
}

// --------------------------------------------------------------- feedback

// Feedback is what a device reports about an action.
type Feedback struct {
	Execution string // closed, proceeding, canceled, scheduled, rejected, resumed, downloaded, download
	Finished  string // success, failure, none
	Details   []string
	Code      *int
	Time      int64 // when it happened, per the device; 0 = now
}

// statusOf maps a report onto an action status, as hawkBit maps it.
func statusOf(f Feedback) string {
	switch strings.ToLower(f.Execution) {
	case "closed":
		if strings.ToLower(f.Finished) == "failure" {
			return model.StatusError
		}
		return model.StatusFinished
	case "canceled":
		return model.StatusCanceled
	case "rejected":
		return model.StatusWarning
	case "download":
		return model.StatusDownload
	case "downloaded":
		return model.StatusDownloaded
	}
	return model.StatusRunning // proceeding, scheduled, resumed
}

// DeploymentFeedback applies a device's report on a deployment.
func (s *Service) DeploymentFeedback(ctx context.Context, t model.Target, actionID int64, f Feedback) error {
	return s.st.Tx(ctx, t.ControllerID, func(tx pgx.Tx, now int64) error {
		t, err := s.st.TargetForUpdate(ctx, tx, t.ControllerID)
		if err != nil {
			return err
		}
		a, err := s.st.ActionOf(ctx, tx, t.ID, actionID)
		if err != nil {
			return err
		}
		if !a.Active {
			return ErrGone
		}
		status := statusOf(f)
		// SWUpdate answers "skip" -- sent outside a maintenance window -- with
		// "closed, success: Skipped Update.": taken at its word, that marks a
		// device updated that is not (hawkBit does exactly that). While the
		// window is shut, a success is the skip acknowledged: the action stays
		// open, scheduled, and the device installs once the window opens. A
		// Qawk addition; see "Where Qawk differs" in the README.
		if status == model.StatusFinished && MaintenanceWindow(a, now) == "unavailable" {
			if a.Status == model.StatusScheduled {
				return nil // acknowledged already
			}
			if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: model.StatusScheduled,
				OccurredAt: now, ReportedAt: now, Code: f.Code,
				Messages: append(append([]string{}, f.Details...), MsgSkipAcknowledged)}); err != nil {
				return err
			}
			return s.st.SetAction(ctx, tx, a.ID, model.StatusScheduled, true, f.Code, t.ControllerID, now)
		}
		at := f.Time
		if at == 0 {
			at = now
		}
		if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: status, OccurredAt: at,
			ReportedAt: now, Code: f.Code, Messages: f.Details}); err != nil {
			return err
		}
		switch {
		case status == model.StatusFinished:
			if err := s.st.SetAction(ctx, tx, a.ID, status, false, f.Code, t.ControllerID, now); err != nil {
				return err
			}
			// What a device says about itself -- its slot, its application
			// versions -- is what an update just changed, so, like hawkBit,
			// ask for it again: the next poll carries a configData link.
			if err := s.st.SetRequestAttributes(ctx, tx, t.ID, true); err != nil {
				return err
			}
			ds := a.DSID
			return s.settle(ctx, tx, t.ID, &ds, &now, false)
		case status == model.StatusError, status == model.StatusCanceled:
			if err := s.st.SetAction(ctx, tx, a.ID, status, false, f.Code, t.ControllerID, now); err != nil {
				return err
			}
			return s.settle(ctx, tx, t.ID, t.InstalledDSID, nil, status == model.StatusError)
		case status == model.StatusDownloaded && a.ActionType == model.TypeDownloadOnly:
			// a download-only action is done once the device has the files
			if err := s.st.SetAction(ctx, tx, a.ID, status, false, f.Code, t.ControllerID, now); err != nil {
				return err
			}
			return s.settle(ctx, tx, t.ID, t.InstalledDSID, nil, false)
		default:
			return s.st.SetAction(ctx, tx, a.ID, status, true, f.Code, t.ControllerID, now)
		}
	})
}

// CancelBase is the device reading a cancellation.
func (s *Service) CancelBase(ctx context.Context, t model.Target, actionID int64) (model.Action, error) {
	var a model.Action
	err := s.st.Tx(ctx, t.ControllerID, func(tx pgx.Tx, now int64) error {
		var err error
		a, err = s.st.ActionOf(ctx, tx, t.ID, actionID)
		if err != nil {
			return err
		}
		if a.Status != model.StatusCanceling {
			return httpx.NotFound("Action", actionID)
		}
		_, err = s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: model.StatusRetrieved,
			OccurredAt: now, ReportedAt: now, Messages: []string{MsgCancelRetrieved}})
		return err
	})
	return a, err
}

// CancelFeedback applies a device's report on a cancellation: closed (or
// canceled) means it stopped, rejected or a failure means it could not.
func (s *Service) CancelFeedback(ctx context.Context, t model.Target, actionID int64, f Feedback) error {
	return s.st.Tx(ctx, t.ControllerID, func(tx pgx.Tx, now int64) error {
		t, err := s.st.TargetForUpdate(ctx, tx, t.ControllerID)
		if err != nil {
			return err
		}
		a, err := s.st.ActionOf(ctx, tx, t.ID, actionID)
		if err != nil {
			return err
		}
		if !a.Active {
			return ErrGone
		}
		exec := strings.ToLower(f.Execution)
		fin := strings.ToLower(f.Finished)
		status := model.StatusCanceling
		active := true
		switch {
		case (exec == "closed" && fin != "failure") || exec == "canceled":
			status, active = model.StatusCanceled, false
		case exec == "rejected" || (exec == "closed" && fin == "failure"):
			status = model.StatusCancelRejected
		}
		at := f.Time
		if at == 0 {
			at = now
		}
		msgs := f.Details
		if status == model.StatusCanceled {
			// hawkBit brackets the device's own words between these two
			msgs = append(append([]string{MsgCancelConfirmed}, f.Details...), MsgCancelCompleted)
		}
		if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: status, OccurredAt: at,
			ReportedAt: now, Code: f.Code, Messages: msgs}); err != nil {
			return err
		}
		if status == model.StatusCancelRejected {
			// the device goes on with the update it could not stop
			status = model.StatusRunning
		}
		if err := s.st.SetAction(ctx, tx, a.ID, status, active, f.Code, t.ControllerID, now); err != nil {
			return err
		}
		if !active {
			return s.settle(ctx, tx, t.ID, t.InstalledDSID, nil, false)
		}
		return nil
	})
}

// ConfigData stores what the device says about itself.
func (s *Service) ConfigData(ctx context.Context, t model.Target, mode string, data map[string]string) error {
	return s.st.Tx(ctx, t.ControllerID, func(tx pgx.Tx, now int64) error {
		if err := s.st.PutAttributes(ctx, tx, t.ID, strings.ToLower(mode), data); err != nil {
			return err
		}
		return s.st.SetRequestAttributes(ctx, tx, t.ID, false)
	})
}

// ------------------------------------------------------------ confirmation

// Confirm applies a device's answer to an action waiting for confirmation.
func (s *Service) Confirm(ctx context.Context, t model.Target, actionID int64, confirmed bool, code *int, details []string) error {
	return s.st.Tx(ctx, t.ControllerID, func(tx pgx.Tx, now int64) error {
		a, err := s.st.ActionOf(ctx, tx, t.ID, actionID)
		if err != nil {
			return err
		}
		if a.Status != model.StatusWaitForConfirmation {
			return ErrGone
		}
		msgs := details
		status := model.StatusWaitForConfirmation
		if confirmed {
			status = model.StatusRunning
			msgs = append([]string{MsgConfirmed}, details...)
		} else {
			msgs = append([]string{MsgDenied}, details...)
		}
		if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: status, OccurredAt: now,
			ReportedAt: now, Code: code, Messages: msgs}); err != nil {
			return err
		}
		return s.st.SetAction(ctx, tx, a.ID, status, true, code, t.ControllerID, now)
	})
}

// SetAutoConfirm turns auto-confirmation on or off for a target. Turning it
// on confirms, there and then, every action still waiting.
func (s *Service) SetAutoConfirm(ctx context.Context, user string, controllerID string, active bool, initiator, remark *string) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		t, err := s.st.TargetForUpdate(ctx, tx, controllerID)
		if err != nil {
			return err
		}
		if err := s.st.SetAutoConfirm(ctx, tx, t.ID, active, initiator, remark, now); err != nil {
			return err
		}
		if !active {
			return nil
		}
		actives, err := s.st.ActiveActions(ctx, tx, t.ID)
		if err != nil {
			return err
		}
		who := user
		if initiator != nil && *initiator != "" {
			who = *initiator
		}
		for _, a := range actives {
			if a.Status != model.StatusWaitForConfirmation {
				continue
			}
			if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: model.StatusRunning,
				OccurredAt: now, ReportedAt: now, Messages: []string{fmt.Sprintf(MsgAutoConfirmed, who)}}); err != nil {
				return err
			}
			if err := s.st.SetAction(ctx, tx, a.ID, model.StatusRunning, true, nil, user, now); err != nil {
				return err
			}
		}
		return nil
	})
}

// ---------------------------------------------------------- operator side

// CancelAction is an operator cancelling an action. Normally the action goes
// to "canceling" and the device is asked to stop; force closes it at once,
// for a device that will never answer.
func (s *Service) CancelAction(ctx context.Context, user string, controllerID string, actionID int64, force bool) error {
	return s.st.Tx(ctx, user, func(tx pgx.Tx, now int64) error {
		t, err := s.st.TargetForUpdate(ctx, tx, controllerID)
		if err != nil {
			return err
		}
		a, err := s.st.ActionOf(ctx, tx, t.ID, actionID)
		if err != nil {
			return err
		}
		if !a.Active {
			return errNotCancelable(a.ID)
		}
		if force {
			if a.Status != model.StatusCanceling {
				return httpx.Custom(400, "hawkbit.server.error.action.notcancelable",
					repoExc+"ForceQuitActionNotAllowedException",
					fmt.Sprintf("Action %d must be canceled before it can be force quit", a.ID))
			}
			if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: model.StatusCanceled,
				OccurredAt: now, ReportedAt: now, Messages: []string{MsgForceQuit}}); err != nil {
				return err
			}
			if err := s.st.SetAction(ctx, tx, a.ID, model.StatusCanceled, false, nil, user, now); err != nil {
				return err
			}
			return s.settle(ctx, tx, t.ID, t.InstalledDSID, nil, false)
		}
		if a.Status == model.StatusCanceling {
			return nil
		}
		if _, err := s.st.AddStatus(ctx, tx, model.ActionStatus{ActionID: a.ID, Status: model.StatusCanceling,
			OccurredAt: now, ReportedAt: now, Messages: []string{MsgCancelRequested}}); err != nil {
			return err
		}
		return s.st.SetAction(ctx, tx, a.ID, model.StatusCanceling, true, nil, user, now)
	})
}
