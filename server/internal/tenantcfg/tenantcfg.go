// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

// Package tenantcfg is the list of tenant configuration keys -- what
// /rest/v1/system/configs exposes -- with hawkBit 1.1.0's defaults.
//
// A key that nobody has set has its default, and the API marks it
// "global": true. Setting it stores a row; deleting the row brings the
// default back. The values below were read off a fresh hawkBit 1.1.0
// (reference/hawkbit-1.1.0-defaults.json).
package tenantcfg

import (
	"fmt"
	"regexp"
	"strconv"
)

type Kind int

const (
	Bool Kind = iota
	Int
	String
	Duration // "HH:MM:SS"
)

type Key struct {
	Name    string
	Kind    Kind
	Default any
}

// Keys, in the order the API lists them.
var Keys = []Key{
	{"action.cleanup.auto.expiry", Int, int64(-1)},
	{"action.cleanup.auto.status", String, "CANCELED,ERROR"},
	{"action.cleanup.onQuotaHit.percent", Int, int64(0)},
	{"authentication.gatewaytoken.enabled", Bool, true},
	{"authentication.gatewaytoken.key", String, ""},
	{"authentication.header.authority", String, ""},
	{"authentication.header.enabled", Bool, false},
	{"authentication.targettoken.enabled", Bool, true},
	{"batch.assignments.enabled", Bool, false},
	{"default.ds.type", Int, int64(0)}, // set at first start to the id of os_app
	{"implicit.lock.enabled", Bool, true},
	{"maintenanceWindowPollCount", Int, int64(3)},
	{"pollingOverdueTime", Duration, "00:05:00"},
	{"pollingTime", Duration, "00:05:00"},
	{"repository.actions.autoclose.enabled", Bool, false},
	{"rollout.approval.enabled", Bool, false},
	{"user.confirmation.flow.enabled", Bool, false},
	{"authentication.anonymous.enabled", Bool, false},
}

var byName = func() map[string]Key {
	m := make(map[string]Key, len(Keys))
	for _, k := range Keys {
		m[k.Name] = k
	}
	return m
}()

func Lookup(name string) (Key, bool) {
	k, ok := byName[name]
	return k, ok
}

var durationRe = regexp.MustCompile(`^\d{2}:[0-5]\d:[0-5]\d$`)

// Normalize checks v against the key's kind and returns it in canonical form
// (bool, int64 or string), or an error that names what was expected.
func Normalize(k Key, v any) (any, error) {
	switch k.Kind {
	case Bool:
		switch x := v.(type) {
		case bool:
			return x, nil
		case string:
			if b, err := strconv.ParseBool(x); err == nil {
				return b, nil
			}
		}
		return nil, fmt.Errorf("%s takes true or false", k.Name)
	case Int:
		switch x := v.(type) {
		case float64:
			return int64(x), nil
		case int64:
			return x, nil
		case string:
			if n, err := strconv.ParseInt(x, 10, 64); err == nil {
				return n, nil
			}
		}
		return nil, fmt.Errorf("%s takes a number", k.Name)
	case Duration:
		s, ok := v.(string)
		if !ok || !durationRe.MatchString(s) {
			return nil, fmt.Errorf("%s takes a duration as HH:MM:SS", k.Name)
		}
		return s, nil
	default:
		switch x := v.(type) {
		case string:
			return x, nil
		case float64:
			return strconv.FormatFloat(x, 'f', -1, 64), nil
		case bool:
			return strconv.FormatBool(x), nil
		}
		return nil, fmt.Errorf("%s takes a string", k.Name)
	}
}

// Seconds turns "HH:MM:SS" into seconds; 0 if it is not one.
func Seconds(s string) int64 {
	if !durationRe.MatchString(s) {
		return 0
	}
	h, _ := strconv.ParseInt(s[0:2], 10, 64)
	m, _ := strconv.ParseInt(s[3:5], 10, 64)
	sec, _ := strconv.ParseInt(s[6:8], 10, 64)
	return h*3600 + m*60 + sec
}
