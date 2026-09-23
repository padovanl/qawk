// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package service

// The messages Qawk writes into an action's status history, word for word as
// hawkBit 1.1.0 writes them (read off a live server, see reference/samples).
//
// They are not decoration: the console reads them. badges.js decides what a
// device is doing from the history -- "Assignment initiated" means the action
// has just been created, a "download" entry means the device is fetching --
// so a different wording here would show the wrong phase on screen.
const (
	MsgAssigned            = "Assignment initiated by user '%s'"
	MsgRetrieved           = "Update Server: Target retrieved update action and should start now the download."
	MsgDownloads           = "Update Server: Target downloads "
	MsgCancelObsolete      = "Update Server: cancel obsolete action due to new update"
	MsgCancelRequested     = "Update Server: cancel action requested by user"
	MsgCancelRetrieved     = "Update Server: Target retrieved cancel action and should start now the cancellation."
	MsgCancelConfirmed     = "Update Server: Cancellation confirmed."
	MsgCancelCompleted     = "Update Server: Cancellation completion is finished successfully."
	MsgForceQuit           = "Update Server: A force quit has been performed."
	MsgWaitForConfirmation = "Waiting for the confirmation by the device before processing with the deployment"
	MsgAutoConfirmed       = "Assignment automatically confirmed by initiator '%s'."
	MsgConfirmed           = "Assignment confirmed by the device."
	MsgDenied              = "Assignment denied by the device."
	MsgRolloutPaused       = "Update Server: rollout paused"
)
