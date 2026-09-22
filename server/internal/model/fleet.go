package model

// Fleet is a set of devices that should run the same release (a Qawk
// addition): dev, beta, prod, a trade show.
type Fleet struct {
	ID          int64
	Name        string
	Description string
	Colour      *string
	// Rule: a target query; matching devices in no fleet join this one.
	Rule *string
	// The release the fleet runs; members behind it are given it.
	DSID       *int64
	DSLabel    *string
	ActionType string

	// The pipeline: the fleet this one takes releases from, and what that
	// fleet must show first. Temporary: devices come back from it (expo).
	UpstreamID   *int64
	UpstreamName *string
	Temporary    bool
	Gate         Gate

	// Delivery inside the fleet: a share of the members at a time, the next
	// wave when the last is done (or after the timeout), and a stop when the
	// failures pass the threshold (a percentage of the devices started).
	WavePercent        int
	WaveTimeoutMinutes int
	ErrorThreshold     int

	FreezeReason *string
	FreezeFrom   *int64
	FreezeUntil  *int64

	Audit

	// what the members are doing, counted when the fleet is read
	Members   int64
	OnRelease int64 // installed the fleet's release
	Updating  int64 // an action open
	Failed    int64 // update status error
	InSystems int64 // members that are part of a system: system deployments update them

	// AutoPromote: promoted by the engine as soon as its gate opens. False
	// (the default): by hand, when someone decides.
	AutoPromote bool

	// The orchestrator: the manifest of the fleet's release, for the members
	// that are part of a system (a 6hd with its st05 and hyper), which the
	// release's set cannot update -- and how its systems are taken.
	ManifestID    *int64
	ManifestLabel *string
	Orchestrator  Orchestration
}

// Orchestration is how a fleet's release updates the fleet's systems.
type Orchestration struct {
	MaxParallel int  // systems at a time
	MaxFailed   int  // systems that may fail before the rest are left alone
	ByCentre    bool // one centre at a time: the next once every system of the last is done
	// Centres the orchestrator takes, in the order it takes them. Empty (the
	// default): every centre of the channel, by name.
	Centres []string
}

// Gate is what a fleet's upstream must show before a release may enter it.
type Gate struct {
	MinDevices       int  // devices of the upstream running the release
	MinSuccess       int  // percentage of the upstream running it
	SoakMinutes      int  // minutes since the release started in the upstream
	ApprovalRequired bool // a second person approves
}

// Frozen: no release reaches the fleet at now.
func (f Fleet) Frozen(now int64) bool {
	if f.FreezeReason == nil {
		return false
	}
	if f.FreezeFrom != nil && now < *f.FreezeFrom {
		return false
	}
	return f.FreezeUntil == nil || now < *f.FreezeUntil
}

const (
	ReleasePending    = "waiting_for_approval"
	ReleaseDenied     = "denied"
	ReleaseActive     = "active"
	ReleaseHalted     = "halted"
	ReleaseCompleted  = "completed"
	ReleaseSuperseded = "superseded"
)

// FleetRelease is a release a fleet was given, or asked for.
type FleetRelease struct {
	ID              int64
	FleetID         int64
	FleetName       string
	DSID            *int64
	DSLabel         string
	FromFleetID     *int64
	FromFleetName   string
	Status          string
	Forced          bool
	Reason          string
	GateReport      string
	RequestedBy     string
	RequestedAt     int64
	DecidedBy       *string
	DecidedAt       *int64
	StartedAt       *int64
	FinishedAt      *int64
	Waves           int
	LastWaveAt      *int64
	FailureBaseline int
	// the orchestrator: the manifest for the fleet's systems, and the system
	// deployment the release started with it
	ManifestID         *int64
	ManifestLabel      string
	SystemDeploymentID *int64
}

// ReleaseProgress is how a fleet's release is going.
type ReleaseProgress struct {
	Members   int64
	OnRelease int64 // run it
	Active    int64 // an action for it open
	Succeeded int64 // finished it since the release started
	Failed    int64 // failed it since the release started, and not succeeded since
}

// FleetMember is a device as a fleet lists it.
type FleetMember struct {
	ControllerID  string
	Name          string
	UpdateStatus  string
	Installed     *string
	Assigned      *string
	LastRequestAt *int64
	JoinedAt      *int64
	Home          *string
}
