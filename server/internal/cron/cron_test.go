// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package cron

import (
	"testing"
	"time"
)

func at(s string) time.Time {
	t, err := time.Parse("2006-01-02 15:04:05", s)
	if err != nil {
		panic(err)
	}
	return t
}

func TestParseRefuses(t *testing.T) {
	for _, e := range []string{
		"0 0 2 * *",          // five fields: a Unix cron, not Quartz
		"0 0 25 * * ?",       // no hour 25
		"0 0 2 L * ?",        // L is not supported
		"? 0 2 * * *",        // ? only for the day fields
		"0 0 2 * * MON#2",    // # is not supported
		"0 */0 * * * ?",      // a step of 0
		"0 0 2 * * ? 2300",   // out of the years
		"0 0 2 * * FOO",      // not a day
		"0 0 2 * * ? 2026 x", // eight fields
	} {
		if _, err := Parse(e); err == nil {
			t.Errorf("%q was accepted", e)
		}
	}
}

func TestNextAndPrev(t *testing.T) {
	cases := []struct {
		expr, from, want string
		next             bool
	}{
		{"0 0 2 * * ?", "2026-09-11 01:59:30", "2026-09-11 02:00:00", true},
		{"0 0 2 * * ?", "2026-09-11 02:00:01", "2026-09-12 02:00:00", true},
		{"0 0 2 * * ?", "2026-09-11 02:30:00", "2026-09-11 02:00:00", false},
		// 2026-09-12 is a Saturday: weekdays at 22:30 are next on Monday the 14th
		{"0 30 22 ? * MON-FRI", "2026-09-12 12:00:00", "2026-09-14 22:30:00", true},
		// Quartz counts days of the week from 1 = Sunday
		{"0 0 12 ? * 1", "2026-09-11 00:00:00", "2026-09-13 12:00:00", true},
		{"0 */15 * * * ?", "2026-09-11 10:07:00", "2026-09-11 10:15:00", true},
		{"30 5/20 * * * ?", "2026-09-11 10:06:00", "2026-09-11 10:25:30", true},
		{"0 0 0 1 JAN,JUL ?", "2026-09-11 00:00:00", "2027-01-01 00:00:00", true},
		{"0 0 3 * * ? 2027", "2026-09-11 00:00:00", "2027-01-01 03:00:00", true},
	}
	for _, c := range cases {
		s, err := Parse(c.expr)
		if err != nil {
			t.Fatalf("%q: %v", c.expr, err)
		}
		var got time.Time
		var ok bool
		if c.next {
			got, ok = s.Next(at(c.from), 400*24*time.Hour)
		} else {
			got, ok = s.Prev(at(c.from), time.Hour)
		}
		if !ok || !got.Equal(at(c.want)) {
			t.Errorf("%q from %s (next=%v): got %v %v, want %s", c.expr, c.from, c.next, got, ok, c.want)
		}
	}
}

func TestNothingToFind(t *testing.T) {
	s, _ := Parse("0 0 0 1 1 ? 2000")
	if got, ok := s.Next(at("2026-09-11 00:00:00"), 5*365*24*time.Hour); ok {
		t.Errorf("a schedule in the past fired at %v", got)
	}
	s, _ = Parse("0 0 2 * * ?")
	if got, ok := s.Prev(at("2026-09-11 04:00:00"), time.Hour); ok {
		t.Errorf("found %v, more than an hour back", got)
	}
}

func TestZone(t *testing.T) {
	// 02:00 at +02:00 is midnight UTC
	s, _ := Parse("0 0 2 * * ?")
	z := time.FixedZone("+02:00", 2*3600)
	got, ok := s.Next(at("2026-09-10 23:00:00").In(z), 24*time.Hour)
	if !ok || !got.Equal(at("2026-09-11 00:00:00")) {
		t.Errorf("got %v %v", got.UTC(), ok)
	}
}
