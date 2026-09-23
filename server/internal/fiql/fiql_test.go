// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package fiql

import (
	"strconv"
	"strings"
	"testing"
)

var testFields = &Fields{
	Plain: map[string]Field{
		"controllerid": {Column: "t.controller_id"},
		"name":         {Column: "t.name"},
		"id":           {Column: "t.id", Kind: Number},
		"valid":        {Column: "d.valid", Kind: Bool},
		"updatestatus": {Column: "t.update_status", Kind: Enum, Values: []string{"in_sync", "pending", "error"}},
		"tag":          {Custom: Exists("tags x WHERE x.t = t.id", "x.name")},
	},
	Prefix: map[string]func(string) Field{
		"attribute": func(k string) Field { return KeyValue("attrs", "target_id", "t.id", "k", "v", k) },
	},
}

func compile(t *testing.T, q string) (string, []any, string) {
	t.Helper()
	var args []any
	bind := func(v any) string { args = append(args, v); return "$" + strconv.Itoa(len(args)) }
	sql, err := Compile(q, testFields, bind)
	code := ""
	if err != nil {
		code = strings.TrimPrefix(err.Code, "hawkbit.server.error.rest.param.")
	}
	return sql, args, code
}

func TestAccepted(t *testing.T) {
	cases := []struct {
		q    string
		sql  string
		args []any
	}{
		{"name==abc", "t.name ILIKE $1", []any{"abc"}},
		{"controllerId==ABC*", "t.controller_id ILIKE $1", []any{"ABC%"}},
		{"name==a;id=gt=3", "(t.name ILIKE $1 AND t.id > $2)", []any{"a", int64(3)}},
		{"name==a,name==b", "(t.name ILIKE $1 OR t.name ILIKE $2)", []any{"a", "b"}},
		{"name==a and id<5", "(t.name ILIKE $1 AND t.id < $2)", []any{"a", int64(5)}},
		{"(name==a,name==b);valid==true", "((t.name ILIKE $1 OR t.name ILIKE $2) AND d.valid = $3)", []any{"a", "b", true}},
		{"updatestatus=in=(in_sync,PENDING)", "lower(t.update_status) IN ($1, $2)", []any{"in_sync", "pending"}},
		{"name=='with space'", "t.name ILIKE $1", []any{"with space"}},
		{"name==100%_off", "t.name ILIKE $1", []any{`100\%\_off`}},
		{"", "TRUE", nil},
	}
	for _, c := range cases {
		sql, args, code := compile(t, c.q)
		if code != "" {
			t.Errorf("%q: refused (%s)", c.q, code)
			continue
		}
		if sql != c.sql {
			t.Errorf("%q:\n  got  %s\n  want %s", c.q, sql, c.sql)
		}
		if len(args) != len(c.args) {
			t.Errorf("%q: args %v, want %v", c.q, args, c.args)
			continue
		}
		for i := range args {
			if args[i] != c.args[i] {
				t.Errorf("%q: arg %d = %#v, want %#v", c.q, i, args[i], c.args[i])
			}
		}
	}
}

func TestRefused(t *testing.T) {
	cases := map[string]string{
		"nonesuch==x":            "rsqlInvalidField", // a field the entity does not have
		"updatestatus==nonsense": "rsqlInvalidField", // a value outside the enum
		"attribute.==x":          "rsqlInvalidField", // a map field with no key
		"valid==maybe":           "rsqlInvalidField",
		"name==":                 "rsqlParamSyntax",
		"name":                   "rsqlParamSyntax",
		"name==a;":               "rsqlParamSyntax",
		"(name==a":               "rsqlParamSyntax",
		"name=='open":            "rsqlParamSyntax",
		"name==a)":               "rsqlParamSyntax",
	}
	for q, want := range cases {
		_, _, code := compile(t, q)
		if code != want {
			t.Errorf("%q: got %q, want %q", q, code, want)
		}
	}
}

// Whatever a client types ends up in a parameter, never in the SQL text.
func TestNothingTypedReachesSQL(t *testing.T) {
	evil := `x'); DROP TABLE targets; --`
	for _, q := range []string{
		"name==\"" + evil + "\"",
		"tag==\"" + evil + "\"",
		"attribute.slot==\"" + evil + "\"",
		"name=in=(\"" + evil + "\",b)",
	} {
		sql, _, code := compile(t, q)
		if code != "" {
			t.Fatalf("%q refused: %s", q, code)
		}
		if strings.Contains(sql, "DROP") {
			t.Errorf("%q leaked into SQL: %s", q, sql)
		}
	}
}

// hawkBit accepts a non-number on a number field and finds nothing.
func TestNotANumberMatchesNothing(t *testing.T) {
	for q, want := range map[string]string{"id==abc": "FALSE", "id!=abc": "TRUE", "id=in=(abc,3)": "t.id IN ($1)"} {
		sql, _, code := compile(t, q)
		if code != "" || sql != want {
			t.Errorf("%q: got %q (%s), want %q", q, sql, code, want)
		}
	}
}

func TestMapFieldsAndTags(t *testing.T) {
	sql, args, code := compile(t, "attribute.device_type==neo-intel")
	if code != "" || !strings.Contains(sql, "EXISTS (SELECT 1 FROM attrs kv WHERE kv.target_id = t.id AND kv.k = $1") {
		t.Fatalf("attribute: %s (%s)", sql, code)
	}
	if args[0] != "device_type" || args[1] != "neo-intel" {
		t.Errorf("attribute args %v", args)
	}
	sql, _, _ = compile(t, "tag!=lab")
	if !strings.HasPrefix(sql, "NOT EXISTS") {
		t.Errorf("tag!= must be a NOT EXISTS: %s", sql)
	}
}
