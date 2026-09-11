package model

// Centre is a place devices are in -- a bowling centre. A centre is in a
// channel (a fleet), and every device of it follows (a Qawk addition).
type Centre struct {
	Centre    string
	Name      string
	FleetID   *int64
	Fleet     *string
	Colour    *string
	Devices   int64
	OnChannel int64 // of its devices, those in its channel
}

// CentreOf is the centre a device is in, and that centre's channel.
type CentreOf struct {
	Centre  string
	FleetID *int64
}
