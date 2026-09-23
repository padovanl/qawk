// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package service

import (
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"qawk/internal/cron"
	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Maintenance windows, as hawkBit has them. An assignment may say when the
// device may install: a Quartz cron schedule for when a window opens, how
// long it stays open (HH:mm:ss), and the time zone offset the schedule is read
// in (+01:00). Outside a window the device is told to download but not to
// install -- "update": "skip", "maintenanceWindow": "unavailable" -- and inside
// one, "available" with the action's own handling. The deploymentBase link
// changes when the window opens, so a device caching by URL reads it again.

// MsgSkipAcknowledged is written when a device reports success for a
// deployment it was told to skip, outside its window.
const MsgSkipAcknowledged = "Update Server: outside its maintenance window the device only acknowledged the skip; " +
	"it installs when the window opens"

func errMaintenance(msg string) error {
	return httpx.Custom(http.StatusBadRequest, "hawkbit.server.error.maintenanceScheduleInvalid",
		repoExc+"InvalidMaintenanceScheduleException", msg)
}

type window struct {
	sched *cron.Schedule
	dur   time.Duration
	zone  *time.Location
}

var (
	offsetRE   = regexp.MustCompile(`^([+-])(\d{1,2})(?::?(\d{2}))?$`)
	durationRE = regexp.MustCompile(`^(\d{1,2}):(\d{2}):(\d{2})$`)
)

// yearsAhead is how far a first window is looked for.
const yearsAhead = 5 * 365 * 24 * time.Hour

func parseWindow(schedule, duration, timezone *string) (*window, error) {
	sc, du, tz := deref(schedule), deref(duration), deref(timezone)
	if sc == "" && du == "" && tz == "" {
		return nil, nil
	}
	if sc == "" || du == "" || tz == "" {
		return nil, errMaintenance("a maintenance window needs a schedule, a duration and a timezone -- or none of them")
	}
	s, err := cron.Parse(sc)
	if err != nil {
		return nil, errMaintenance("the maintenance schedule is not a valid cron expression: " + err.Error())
	}
	m := durationRE.FindStringSubmatch(du)
	if m == nil {
		return nil, errMaintenance(fmt.Sprintf("%q: a maintenance window's duration is HH:mm:ss", du))
	}
	h, _ := strconv.Atoi(m[1])
	mi, _ := strconv.Atoi(m[2])
	se, _ := strconv.Atoi(m[3])
	if h > 23 || mi > 59 || se > 59 || h+mi+se == 0 {
		return nil, errMaintenance(fmt.Sprintf("%q: a maintenance window lasts from 00:00:01 to 23:59:59", du))
	}
	zone, err := parseOffset(tz)
	if err != nil {
		return nil, err
	}
	return &window{sched: s, zone: zone,
		dur: time.Duration(h)*time.Hour + time.Duration(mi)*time.Minute + time.Duration(se)*time.Second}, nil
}

func parseOffset(tz string) (*time.Location, error) {
	if tz == "Z" {
		return time.UTC, nil
	}
	m := offsetRE.FindStringSubmatch(tz)
	if m == nil {
		return nil, errMaintenance(fmt.Sprintf("%q: a maintenance window's timezone is an offset, such as +01:00", tz))
	}
	h, _ := strconv.Atoi(m[2])
	mi := 0
	if m[3] != "" {
		mi, _ = strconv.Atoi(m[3])
	}
	if h > 18 || mi > 59 {
		return nil, errMaintenance(fmt.Sprintf("%q is not an offset", tz))
	}
	off := h*3600 + mi*60
	if m[1] == "-" {
		off = -off
	}
	return time.FixedZone(tz, off), nil
}

// open: the start of the window open at now, if one is.
func (w *window) open(now time.Time) (time.Time, bool) {
	t := now.In(w.zone)
	f, ok := w.sched.Prev(t, w.dur)
	return f, ok && t.Before(f.Add(w.dur))
}

// next is the start of the window open now, or else of the next one.
func (w *window) next(now time.Time) (time.Time, bool) {
	if f, ok := w.open(now); ok {
		return f, true
	}
	return w.sched.Next(now.In(w.zone), yearsAhead)
}

// validateWindow refuses what hawkBit refuses: a window half given, a
// schedule, duration or zone it cannot read, a window that never comes.
func validateWindow(r AssignRequest, now int64) error {
	w, err := parseWindow(r.MaintenanceSchedule, r.MaintenanceDuration, r.MaintenanceTimezone)
	if err != nil || w == nil {
		return err
	}
	if _, ok := w.next(time.UnixMilli(now)); !ok {
		return errMaintenance("No valid maintenance window available after current time")
	}
	return nil
}

// MaintenanceWindow is what the device is told about an action's window:
// "available", "unavailable", or "" when it has none.
func MaintenanceWindow(a model.Action, now int64) string {
	w, err := parseWindow(a.MaintenanceSchedule, a.MaintenanceDuration, a.MaintenanceTimezone)
	if err != nil || w == nil {
		return ""
	}
	if _, ok := w.open(time.UnixMilli(now)); ok {
		return "available"
	}
	return "unavailable"
}

// NextMaintenance is when an action's window opens -- or opened, while it
// is open -- in epoch milliseconds: hawkBit's nextStartAt.
func NextMaintenance(a model.Action, now int64) (int64, bool) {
	w, err := parseWindow(a.MaintenanceSchedule, a.MaintenanceDuration, a.MaintenanceTimezone)
	if err != nil || w == nil {
		return 0, false
	}
	f, ok := w.next(time.UnixMilli(now))
	return f.UnixMilli(), ok
}
