// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package mgmt

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"qawk/internal/httpx"
	"qawk/internal/store"
)

func (a *API) actionRoutes(r chi.Router) {
	need(r, "READ_TARGET").Get("/actions", a.listActions)
	need(r, "UPDATE_TARGET").Delete("/actions", a.deleteActions)
	need(r, "READ_TARGET").Get("/actions/{actionId}", a.getAction)
	need(r, "UPDATE_TARGET").Delete("/actions/{actionId}", a.deleteAction)
}

func (a *API) listActions(w http.ResponseWriter, r *http.Request) { a.sendActions(w, r, nil) }

func (a *API) getAction(w http.ResponseWriter, r *http.Request) {
	aid, found := pathID(w, r, "actionId", "Action")
	if !found {
		return
	}
	act, err := a.st.Action(r.Context(), a.st.DB(), aid)
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, actionJSON(a.base(r), act, true))
}

func (a *API) deleteAction(w http.ResponseWriter, r *http.Request) {
	aid, found := pathID(w, r, "actionId", "Action")
	if !found {
		return
	}
	if err := a.svc.DeleteActions(r.Context(), user(r), []int64{aid}); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

// deleteActions deletes closed actions named by ?actionIds=1,2 or selected
// by ?q=.
func (a *API) deleteActions(w http.ResponseWriter, r *http.Request) {
	var ids []int64
	if v := r.URL.Query().Get("actionIds"); v != "" {
		for _, s := range strings.Split(v, ",") {
			n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
			if err != nil {
				fail(w, httpx.Validation("actionIds must be numbers"))
				return
			}
			ids = append(ids, n)
		}
	} else if q := r.URL.Query().Get("q"); q != "" {
		var err error
		ids, err = a.st.ActionIDs(r.Context(), q, func(x *store.Args) []string { return []string{"NOT a.active"} })
		if err != nil {
			fail(w, err)
			return
		}
	} else {
		fail(w, httpx.Validation("give actionIds or q"))
		return
	}
	if err := a.svc.DeleteActions(r.Context(), user(r), ids); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

// json_raw accepts an id written as a number or as a string: hawkBit's own
// clients send both, and the target of an assignment is a controller id
// where the set of one is a number.
type json_raw struct{ raw json.RawMessage }

func (j *json_raw) UnmarshalJSON(b []byte) error { j.raw = append(j.raw[:0], b...); return nil }

func (j json_raw) String() string {
	var s string
	if json.Unmarshal(j.raw, &s) == nil {
		return s
	}
	return strings.TrimSpace(string(j.raw))
}

func (j json_raw) Int() (int64, error) { return strconv.ParseInt(j.String(), 10, 64) }
