// Package reference holds hawkBit 1.1.0's own API descriptions, recorded from
// a running server, and the samples of what it answered.
//
// Qawk serves an OpenAPI document built from these: the operation
// descriptions are hawkBit's, and only the operations Qawk really implements
// are listed. The console checks that document to decide whether the server
// it talks to has what it needs, so listing an operation that does not exist
// would make that check lie.
package reference

import _ "embed"

//go:embed hawkbit-1.1.0-Management-API.json
var ManagementAPI []byte

//go:embed hawkbit-1.1.0-Direct-Device-Integration-API.json
var DDIAPI []byte
