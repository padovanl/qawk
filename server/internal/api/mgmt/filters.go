package mgmt

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

func (a *API) filterRoutes(r chi.Router) {
	need(r, "READ_TARGET").Get("/targetfilters", a.listFilters)
	need(r, "CREATE_TARGET").Post("/targetfilters", a.createFilter)
	need(r, "READ_TARGET").Get("/targetfilters/{filterId}", a.getFilter)
	need(r, "UPDATE_TARGET").Put("/targetfilters/{filterId}", a.updateFilter)
	need(r, "DELETE_TARGET").Delete("/targetfilters/{filterId}", a.deleteFilter)
	need(r, "READ_TARGET").Get("/targetfilters/{filterId}/autoAssignDS", a.getAutoAssign)
	need(r, "UPDATE_TARGET").Post("/targetfilters/{filterId}/autoAssignDS", a.setAutoAssign)
	need(r, "UPDATE_TARGET").Delete("/targetfilters/{filterId}/autoAssignDS", a.clearAutoAssign)
}

func (a *API) filterOf(w http.ResponseWriter, r *http.Request) (model.TargetFilter, bool) {
	fid, found := pathID(w, r, "filterId", "TargetFilterQuery")
	if !found {
		return model.TargetFilter{}, false
	}
	f, err := a.st.TargetFilter(r.Context(), a.st.DB(), fid)
	if err != nil {
		fail(w, err)
		return f, false
	}
	return f, true
}

func (a *API) listFilters(w http.ResponseWriter, r *http.Request) {
	p, good := pageOf(w, r)
	if !good {
		return
	}
	fs, total, err := a.st.TargetFilters(r.Context(), p, nil)
	if err != nil {
		fail(w, err)
		return
	}
	b := a.base(r)
	out := make([]map[string]any, 0, len(fs))
	for _, f := range fs {
		out = append(out, filterJSON(b, f, false))
	}
	sendList(w, out, total)
}

type filterBody struct {
	Name  *string `json:"name"`
	Query *string `json:"query"`
}

// The query is checked when the filter is saved: a filter that can never
// match, found out only when someone relies on it, is the expensive kind of
// mistake.
func (a *API) createFilter(w http.ResponseWriter, r *http.Request) {
	var body filterBody
	if !decode(w, r, &body) {
		return
	}
	if strings.TrimSpace(str(body.Name)) == "" || strings.TrimSpace(str(body.Query)) == "" {
		fail(w, httpx.Validation("a target filter needs a name and a query"))
		return
	}
	if err := a.st.CheckQuery(*body.Query); err != nil {
		fail(w, err)
		return
	}
	var f model.TargetFilter
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		id, err := a.st.CreateTargetFilter(r.Context(), tx, user(r), now, model.TargetFilter{Name: *body.Name, Query: *body.Query})
		if err != nil {
			return err
		}
		f, err = a.st.TargetFilter(r.Context(), tx, id)
		return err
	})
	if err != nil {
		fail(w, err)
		return
	}
	sendCreated(w, filterJSON(a.base(r), f, true))
}

func (a *API) getFilter(w http.ResponseWriter, r *http.Request) {
	if f, found := a.filterOf(w, r); found {
		sendOK(w, filterJSON(a.base(r), f, true))
	}
}

func (a *API) updateFilter(w http.ResponseWriter, r *http.Request) {
	var body filterBody
	if !decode(w, r, &body) {
		return
	}
	f, found := a.filterOf(w, r)
	if !found {
		return
	}
	if body.Name != nil {
		f.Name = *body.Name
	}
	if body.Query != nil {
		if err := a.st.CheckQuery(*body.Query); err != nil {
			fail(w, err)
			return
		}
		f.Query = *body.Query
	}
	a.saveFilter(w, r, f)
}

func (a *API) saveFilter(w http.ResponseWriter, r *http.Request, f model.TargetFilter) {
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		if err := a.st.UpdateTargetFilter(r.Context(), tx, user(r), now, f); err != nil {
			return err
		}
		var err error
		f, err = a.st.TargetFilter(r.Context(), tx, f.ID)
		return err
	})
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, filterJSON(a.base(r), f, true))
}

func (a *API) deleteFilter(w http.ResponseWriter, r *http.Request) {
	f, found := a.filterOf(w, r)
	if !found {
		return
	}
	if err := a.tx(r, func(tx pgx.Tx, now int64) error { return a.st.DeleteTargetFilter(r.Context(), tx, f.ID) }); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) getAutoAssign(w http.ResponseWriter, r *http.Request) {
	f, found := a.filterOf(w, r)
	if found {
		a.sendSetOrNothing(w, r, f.AutoAssignDSID)
	}
}

func (a *API) setAutoAssign(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ID                   int64  `json:"id"`
		Type                 string `json:"type"`
		Weight               *int   `json:"weight"`
		ConfirmationRequired *bool  `json:"confirmationRequired"`
	}
	if !decode(w, r, &body) {
		return
	}
	f, found := a.filterOf(w, r)
	if !found {
		return
	}
	ds, err := a.st.DistributionSet(r.Context(), a.st.DB(), body.ID)
	if err != nil {
		fail(w, err)
		return
	}
	if !ds.Complete || !ds.Valid || ds.Deleted {
		fail(w, httpx.Custom(400, "hawkbit.server.error.distributionset.incomplete",
			"org.eclipse.hawkbit.repository.exception.IncompleteDistributionSetException",
			"only a complete, valid distribution set can be auto-assigned"))
		return
	}
	typ := strings.ToLower(body.Type)
	if typ == "" {
		typ = model.TypeForced
	}
	f.AutoAssignDSID = &ds.ID
	f.AutoAssignActionType = &typ
	f.AutoAssignWeight = body.Weight
	f.ConfirmationRequired = body.ConfirmationRequired
	a.saveFilter(w, r, f)
}

func (a *API) clearAutoAssign(w http.ResponseWriter, r *http.Request) {
	f, found := a.filterOf(w, r)
	if !found {
		return
	}
	f.AutoAssignDSID, f.AutoAssignActionType, f.AutoAssignWeight, f.ConfirmationRequired = nil, nil, nil, nil
	err := a.tx(r, func(tx pgx.Tx, now int64) error { return a.st.UpdateTargetFilter(r.Context(), tx, user(r), now, f) })
	if err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}
