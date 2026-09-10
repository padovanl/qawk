package model

// Fleet is a set of devices that should run the same release (a Qawk
// addition): beta, production, staging.
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
	Audit

	// what the members are doing, counted when the fleet is read
	Members   int64
	OnRelease int64 // installed the fleet's release
	Updating  int64 // an action open
	Failed    int64 // update status error
}
