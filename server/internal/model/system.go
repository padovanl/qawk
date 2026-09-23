// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package model

// Systems (a Qawk addition, after Mender Orchestrator).

const (
	SDDraft    = "draft"
	SDRunning  = "running"
	SDPaused   = "paused"
	SDFinished = "finished"
	SDFailed   = "failed"
	SDAborted  = "aborted"

	RunPending     = "pending"
	RunRunning     = "running"
	RunSucceeded   = "succeeded"
	RunRollingBack = "rolling_back"
	RunRolledBack  = "rolled_back"
	RunSkipped     = "skipped"
)

// SystemType is Mender's topology: the components of a kind of system, and
// how a device says which system it is in.
type SystemType struct {
	ID          int64
	Name        string
	Description string
	KeyField    string // attribute.<key> or metadata.<key>
	GroupField  string // the same, saying which centre a system is in; "" none
	Components  []SystemComponent
	Audit
}

type SystemComponent struct {
	ComponentType string
	Match         string // a target query recognising its devices
}

// Manifest is the state a system type should reach.
type Manifest struct {
	ID           int64
	Name         string
	Description  string
	SystemTypeID int64
	SystemType   string
	Components   []ManifestComponent
	Audit
}

type ManifestComponent struct {
	ComponentType string
	DSID          int64
	DSLabel       string
	Order         int
}

// SystemDeployment applies a manifest to systems of its type.
type SystemDeployment struct {
	ID          int64
	Name        string
	ManifestID  int64
	Manifest    string
	Systems     []string // nil: every system of the type
	FleetID     *int64   // only systems whose devices are all in this fleet (channel)
	Fleet       *string
	Groups      []string // only systems in these groups (centres); nil: any
	MaxParallel int
	MaxFailed   int
	ActionType  string
	ByGroup     bool // one group (centre) at a time
	Status      string
	Reason      string
	StartedBy   *string
	StartedAt   *int64
	FinishedAt  *int64
	Audit
}

// SystemRun is one system of a deployment.
type SystemRun struct {
	ID           int64
	DeploymentID int64
	SystemKey    string
	Group        string // its centre
	GroupRank    int    // its centre's place in the order the deployment takes them
	Status       string
	CurrentOrder *int
	Reason       string
	StartedAt    *int64
	StageAt      *int64
	RollbackAt   *int64
	FinishedAt   *int64
}

// StageProgress counts the devices of a run's current order.
type StageProgress struct {
	Targets, Already, Succeeded, Failed, Active, Unassigned int64
}

// RunComponent is how one component of one run is going.
type RunComponent struct {
	ComponentType string
	Order         int
	Devices       int64
	OnSet         int64 // run the manifest's set
	Back          int64 // put back on their previous set
}

// RollbackProgress counts devices being put back on what they ran before.
type RollbackProgress struct {
	Sent   int64 // were sent their previous set
	Done   int64 // run it again
	Failed int64 // failed to
	Active int64 // an action for it open
	None   int64 // were updated, but ran nothing before: nothing to put back
}
