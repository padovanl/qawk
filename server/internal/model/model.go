// Package model holds the things Qawk manages, as plain structs.
//
// Nothing here knows about HTTP or SQL: the store fills these, the service
// changes them, and each API turns them into its own wire format. That split
// is what lets a second protocol (DMF over AMQP, later) reuse everything but
// the last step.
package model

// Audit is the four fields every hawkBit entity carries.
type Audit struct {
	CreatedAt      int64
	CreatedBy      string
	LastModifiedAt int64
	LastModifiedBy string
}

// ------------------------------------------------------------------ types

type SMType struct {
	ID             int64
	Key            string
	Name           string
	Description    string
	Colour         *string
	MaxAssignments int
	MinArtifacts   int
	Deleted        bool
	Audit
}

type DSType struct {
	ID          int64
	Key         string
	Name        string
	Description string
	Colour      *string
	Deleted     bool
	Audit
}

type TargetType struct {
	ID          int64
	Key         string
	Name        string
	Description string
	Colour      *string
	Audit
}

// -------------------------------------------------------------- software

type SoftwareModule struct {
	ID          int64
	TypeID      int64
	TypeKey     string
	TypeName    string
	Name        string
	Version     string
	Description string
	Vendor      string
	Encrypted   bool
	Locked      bool
	Deleted     bool
	// Complete: it has at least as many artifacts as its type demands.
	Complete bool
	Audit
}

type Artifact struct {
	ID       int64
	SMID     int64
	Filename string
	SHA1     string
	MD5      string
	SHA256   string
	Size     int64
	Audit
}

type Metadata struct {
	Key           string
	Value         string
	TargetVisible bool
}

type DistributionSet struct {
	ID                    int64
	TypeID                int64
	TypeKey               string
	TypeName              string
	Name                  string
	Version               string
	Description           string
	RequiredMigrationStep bool
	Locked                bool
	Valid                 bool
	Deleted               bool
	// Complete: every module type its type makes mandatory is present.
	Complete bool
	Modules  []SoftwareModule
	Audit
}

// Label is how hawkBit names a set in links: "name:version".
func (d DistributionSet) Label() string { return d.Name + ":" + d.Version }

// --------------------------------------------------------------- targets

// Update status of a target, as the API spells it.
const (
	UpdateRegistered = "registered"
	UpdatePending    = "pending"
	UpdateInSync     = "in_sync"
	UpdateError      = "error"
	UpdateUnknown    = "unknown"
)

type Target struct {
	ID                   int64
	ControllerID         string
	Name                 string
	Description          string
	Group                *string
	TypeID               *int64
	TypeName             *string
	SecurityToken        string
	Address              *string
	LastRequestAt        *int64
	InstalledAt          *int64
	AssignedDSID         *int64
	InstalledDSID        *int64
	UpdateStatus         string
	RequestAttributes    bool
	AutoConfirmActive    bool
	AutoConfirmInitiator *string
	AutoConfirmRemark    *string
	AutoConfirmAt        *int64
	Audit
}

type Tag struct {
	ID          int64
	Name        string
	Description string
	Colour      *string
	Audit
}

type TargetFilter struct {
	ID                   int64
	Name                 string
	Query                string
	AutoAssignDSID       *int64
	AutoAssignActionType *string
	AutoAssignWeight     *int
	ConfirmationRequired *bool
	Audit
}

// --------------------------------------------------------------- actions

// Action status, as the API spells it. The status of an action is the LAST
// one reported, not its outcome: a finished action that the device polls
// again reads "retrieved" -- which is hawkBit's behaviour, and the console
// already knows to read the history for the outcome.
const (
	StatusRunning             = "running"
	StatusFinished            = "finished"
	StatusError               = "error"
	StatusWarning             = "warning"
	StatusCanceled            = "canceled"
	StatusCanceling           = "canceling"
	StatusRetrieved           = "retrieved"
	StatusDownload            = "download"
	StatusDownloaded          = "downloaded"
	StatusScheduled           = "scheduled"
	StatusCancelRejected      = "cancel_rejected"
	StatusWaitForConfirmation = "wait_for_confirmation"
)

// Action types ("forceType" in the API).
const (
	TypeSoft         = "soft"
	TypeForced       = "forced"
	TypeTimeForced   = "timeforced"
	TypeDownloadOnly = "downloadonly"
)

type Action struct {
	ID                  int64
	TargetID            int64
	ControllerID        string
	DSID                int64
	DSLabel             string
	ActionType          string
	ForcedTime          int64
	Status              string
	Active              bool
	Weight              *int
	RolloutID           *int64
	RolloutName         *string
	RolloutGroupID      *int64
	RolloutGroupName    *string
	MaintenanceSchedule *string
	MaintenanceDuration *string
	MaintenanceTimezone *string
	InitiatedBy         string
	ExternalRef         *string
	LastStatusCode      *int
	Audit
}

type ActionStatus struct {
	ID         int64
	ActionID   int64
	Status     string
	OccurredAt int64
	ReportedAt int64
	Code       *int
	Messages   []string
}

// -------------------------------------------------------------- rollouts

const (
	RolloutCreating           = "creating"
	RolloutReady              = "ready"
	RolloutWaitingForApproval = "waiting_for_approval"
	RolloutApprovalDenied     = "approval_denied"
	RolloutStarting           = "starting"
	RolloutRunning            = "running"
	RolloutPaused             = "paused"
	RolloutStopping           = "stopping"
	RolloutStopped            = "stopped"
	RolloutFinished           = "finished"
	RolloutDeleting           = "deleting"
	RolloutDeleted            = "deleted"
)

const (
	GroupCreating  = "creating"
	GroupReady     = "ready"
	GroupScheduled = "scheduled"
	GroupRunning   = "running"
	GroupFinished  = "finished"
	GroupError     = "error"
)

type Rollout struct {
	ID                   int64
	Name                 string
	Description          string
	DSID                 int64
	DSLabel              string
	TargetFilterQuery    string
	ActionType           string
	ForcedTime           int64
	Weight               *int
	Status               string
	Dynamic              bool
	StartAt              *int64
	ConfirmationRequired *bool
	ApprovalDecidedBy    *string
	ApprovalRemark       *string
	TotalTargets         int64
	Deleted              bool
	Audit
}

type Condition struct {
	Condition  string
	Expression string
}

type RolloutGroup struct {
	ID                   int64
	RolloutID            int64
	Position             int
	Name                 string
	Description          string
	Status               string
	TargetFilterQuery    string
	TargetPercentage     float64
	SuccessCondition     Condition
	SuccessAction        Condition
	ErrorCondition       *Condition
	ErrorAction          *Condition
	ConfirmationRequired *bool
	Dynamic              bool
	TotalTargets         int64
	Audit
}

// ------------------------------------------------------------- downloads

// Download is how far a device has got with one artifact of an action (a
// Qawk addition: hawkBit does not know).
type Download struct {
	ActionID     int64
	ControllerID string
	ArtifactID   int64
	Filename     string
	Size         int64
	Bytes        int64
	// Ranged: fetched in ranges, as a delta is. Only the needed parts are
	// read, so the bytes say how much came, not how much is left.
	Ranged      bool
	StartedAt   int64
	UpdatedAt   int64
	CompletedAt *int64
}
