package qawkapi

import (
	"net/http"
	"strings"

	"qawk/internal/httpx"
	"qawk/internal/store"
)

// What a console needs for a page of targets, and what is going on in the
// whole fleet -- one request each (a Qawk addition).

// maxIDs is how many targets one request may ask about: a page, not a fleet.
const maxIDs = 500

func idsParam(w http.ResponseWriter, r *http.Request) ([]string, bool) {
	var ids []string
	for _, s := range strings.Split(r.URL.Query().Get("ids"), ",") {
		if s = strings.TrimSpace(s); s != "" {
			ids = append(ids, s)
		}
	}
	if len(ids) > maxIDs {
		httpx.WriteError(w, httpx.Validation("ask about at most 500 targets at a time: a page, not the fleet"))
		return nil, false
	}
	return ids, true
}

// targetStates: ?ids=a,b,c -- for each, its latest action, the newest forty
// entries of that action's history (as the Management API gives them) and
// Qawk's download counts: all a console needs to say what the device is doing.
func (a *API) targetStates(w http.ResponseWriter, r *http.Request) {
	ids, ok := idsParam(w, r)
	if !ok {
		return
	}
	out := []map[string]any{}
	if len(ids) > 0 {
		states, err := a.st.TargetStates(r.Context(), ids, 40)
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		for _, id := range ids {
			st := states[id]
			if st == nil {
				continue
			}
			statuses := make([]map[string]any, 0, len(st.Statuses))
			for _, s := range st.Statuses {
				msgs := s.Messages
				if msgs == nil {
					msgs = []string{}
				}
				statuses = append(statuses, map[string]any{"id": s.ID, "type": s.Status, "messages": msgs,
					"timestamp": s.OccurredAt, "reportedAt": s.ReportedAt})
			}
			dls := make([]map[string]any, 0, len(st.Downloads))
			for _, d := range st.Downloads {
				dls = append(dls, downloadJSON(d))
			}
			set := func(r *store.SetRef) any {
				if r == nil {
					return nil
				}
				return map[string]any{"id": r.ID, "name": r.Name, "version": r.Version, "type": r.Type}
			}
			out = append(out, map[string]any{"controllerId": id, "actionId": st.ActionID, "active": st.Active,
				"dsType": st.DSType, "statuses": statuses, "downloads": dls,
				"assigned": set(st.Assigned), "installed": set(st.Installed), "fleet": fleetRef(st.Fleet, st.FleetColour)})
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}

func fleetRef(name, colour *string) any {
	if name == nil {
		return nil
	}
	return map[string]any{"name": *name, "colour": deref(colour)}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// targetAttributes: ?ids=a,b,c -- the attributes of each, in one request.
func (a *API) targetAttributes(w http.ResponseWriter, r *http.Request) {
	ids, ok := idsParam(w, r)
	if !ok {
		return
	}
	out := map[string]map[string]string{}
	if len(ids) > 0 {
		m, err := a.st.AttributesOfMany(r.Context(), ids)
		if err != nil {
			httpx.WriteError(w, err)
			return
		}
		for _, id := range ids {
			if m[id] != nil {
				out[id] = m[id]
			} else {
				out[id] = map[string]string{}
			}
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out})
}

// deployments: what is going on in the whole fleet -- fleet releases,
// rollouts, sets assigned by hand -- with what their devices are doing.
func (a *API) deployments(w http.ResponseWriter, r *http.Request) {
	ds, err := a.svc.Deployments(r.Context())
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	out := make([]map[string]any, 0, len(ds))
	for _, d := range ds {
		out = append(out, map[string]any{
			"kind": d.Kind, "title": d.Title, "colour": d.Colour, "distributionSetId": d.DSID, "distributionSet": d.DSLabel,
			"dsType": d.DSType, "fleetId": d.FleetID, "rolloutId": d.RolloutID, "status": d.Status, "detail": d.Detail,
			"total": d.Total, "done": d.Done, "failed": d.Failed,
			"open": d.Open, "waiting": d.Waiting, "scheduled": d.Scheduled, "downloading": d.Downloading,
			"installing": d.Installing, "confirming": d.Confirming, "canceling": d.Canceling,
			"since": d.Since, "by": d.By,
		})
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"content": out, "total": len(out)})
}
