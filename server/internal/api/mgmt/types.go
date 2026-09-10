package mgmt

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
)

// Software module types, distribution set types, target types.

func (a *API) typeRoutes(r chi.Router) {
	need(r, "READ_REPOSITORY").Get("/softwaremoduletypes", a.listSMTypes)
	need(r, "CREATE_REPOSITORY").Post("/softwaremoduletypes", a.createSMTypes)
	need(r, "READ_REPOSITORY").Get("/softwaremoduletypes/{smtId}", a.getSMType)
	need(r, "UPDATE_REPOSITORY").Put("/softwaremoduletypes/{smtId}", a.updateSMType)
	need(r, "DELETE_REPOSITORY").Delete("/softwaremoduletypes/{smtId}", a.deleteSMType)

	need(r, "READ_REPOSITORY").Get("/distributionsettypes", a.listDSTypes)
	need(r, "CREATE_REPOSITORY").Post("/distributionsettypes", a.createDSTypes)
	need(r, "READ_REPOSITORY").Get("/distributionsettypes/{dstId}", a.getDSType)
	need(r, "UPDATE_REPOSITORY").Put("/distributionsettypes/{dstId}", a.updateDSType)
	need(r, "DELETE_REPOSITORY").Delete("/distributionsettypes/{dstId}", a.deleteDSType)
	for _, kind := range []struct {
		path      string
		mandatory bool
	}{{"mandatorymoduletypes", true}, {"optionalmoduletypes", false}} {
		k := kind
		need(r, "READ_REPOSITORY").Get("/distributionsettypes/{dstId}/"+k.path, a.dsTypeModules(k.mandatory))
		need(r, "UPDATE_REPOSITORY").Post("/distributionsettypes/{dstId}/"+k.path, a.addDSTypeModule(k.mandatory))
		need(r, "READ_REPOSITORY").Get("/distributionsettypes/{dstId}/"+k.path+"/{smtId}", a.dsTypeModule(k.mandatory))
		need(r, "UPDATE_REPOSITORY").Delete("/distributionsettypes/{dstId}/"+k.path+"/{smtId}", a.removeDSTypeModule(k.mandatory))
	}

	need(r, "READ_TARGET").Get("/targettypes", a.listTargetTypes)
	need(r, "CREATE_TARGET").Post("/targettypes", a.createTargetTypes)
	need(r, "READ_TARGET").Get("/targettypes/{ttId}", a.getTargetType)
	need(r, "UPDATE_TARGET").Put("/targettypes/{ttId}", a.updateTargetType)
	need(r, "DELETE_TARGET").Delete("/targettypes/{ttId}", a.deleteTargetType)
	need(r, "READ_TARGET").Get("/targettypes/{ttId}/compatibledistributionsettypes", a.compatibleTypes)
	need(r, "UPDATE_TARGET").Post("/targettypes/{ttId}/compatibledistributionsettypes", a.addCompatibleTypes)
	need(r, "UPDATE_TARGET").Delete("/targettypes/{ttId}/compatibledistributionsettypes/{dstId}", a.removeCompatibleType)
}

type typeBody struct {
	Key            string  `json:"key"`
	Name           string  `json:"name"`
	Description    *string `json:"description"`
	Colour         *string `json:"colour"`
	MaxAssignments *int    `json:"maxAssignments"`
	MinArtifacts   *int    `json:"minArtifacts"`
	Mandatory      []struct {
		ID int64 `json:"id"`
	} `json:"mandatorymodules"`
	Optional []struct {
		ID int64 `json:"id"`
	} `json:"optionalmodules"`
	Compatible []struct {
		ID int64 `json:"id"`
	} `json:"compatibledistributionsettypes"`
}

// ------------------------------------------------------ software module types

func (a *API) listSMTypes(w http.ResponseWriter, r *http.Request) {
	p, good := pageOf(w, r)
	if !good {
		return
	}
	ts, total, err := a.st.SMTypes(r.Context(), p)
	if err != nil {
		fail(w, err)
		return
	}
	b := a.base(r)
	out := make([]map[string]any, 0, len(ts))
	for _, t := range ts {
		out = append(out, smTypeJSON(b, t))
	}
	sendList(w, out, total)
}

func (a *API) createSMTypes(w http.ResponseWriter, r *http.Request) {
	var body []typeBody
	if !decode(w, r, &body) {
		return
	}
	var ids []int64
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		for _, b := range body {
			if b.Key == "" || b.Name == "" {
				return httpx.Validation("a software module type needs a key and a name")
			}
			t := model.SMType{Key: b.Key, Name: b.Name, Description: str(b.Description), Colour: b.Colour,
				MaxAssignments: 1, MinArtifacts: 0}
			if b.MaxAssignments != nil {
				t.MaxAssignments = *b.MaxAssignments
			}
			if b.MinArtifacts != nil {
				t.MinArtifacts = *b.MinArtifacts
			}
			id, err := a.st.CreateSMType(r.Context(), tx, user(r), now, t)
			if err != nil {
				return err
			}
			ids = append(ids, id)
		}
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	out := []J{}
	for _, id := range ids {
		if t, err := a.st.SMType(r.Context(), a.st.DB(), id); err == nil {
			out = append(out, smTypeJSON(a.base(r), t))
		}
	}
	sendCreated(w, out)
}

func (a *API) smTypeOf(w http.ResponseWriter, r *http.Request) (model.SMType, bool) {
	tid, found := pathID(w, r, "smtId", "SoftwareModuleType")
	if !found {
		return model.SMType{}, false
	}
	t, err := a.st.SMType(r.Context(), a.st.DB(), tid)
	if err != nil {
		fail(w, err)
		return t, false
	}
	return t, true
}

func (a *API) getSMType(w http.ResponseWriter, r *http.Request) {
	if t, found := a.smTypeOf(w, r); found {
		sendOK(w, smTypeJSON(a.base(r), t))
	}
}

func (a *API) updateSMType(w http.ResponseWriter, r *http.Request) {
	var body typeBody
	if !decode(w, r, &body) {
		return
	}
	t, found := a.smTypeOf(w, r)
	if !found {
		return
	}
	if body.Description != nil {
		t.Description = *body.Description
	}
	if body.Colour != nil {
		t.Colour = body.Colour
	}
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		if err := a.st.UpdateSMType(r.Context(), tx, user(r), now, t); err != nil {
			return err
		}
		var err error
		t, err = a.st.SMType(r.Context(), tx, t.ID)
		return err
	})
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, smTypeJSON(a.base(r), t))
}

func (a *API) deleteSMType(w http.ResponseWriter, r *http.Request) {
	t, found := a.smTypeOf(w, r)
	if !found {
		return
	}
	if err := a.tx(r, func(tx pgx.Tx, now int64) error { return a.st.DeleteSMType(r.Context(), tx, t.ID) }); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

// ---------------------------------------------------- distribution set types

func (a *API) listDSTypes(w http.ResponseWriter, r *http.Request) {
	p, good := pageOf(w, r)
	if !good {
		return
	}
	ts, total, err := a.st.DSTypes(r.Context(), p)
	if err != nil {
		fail(w, err)
		return
	}
	b := a.base(r)
	out := make([]map[string]any, 0, len(ts))
	for _, t := range ts {
		out = append(out, dsTypeJSON(b, t, false))
	}
	sendList(w, out, total)
}

func (a *API) createDSTypes(w http.ResponseWriter, r *http.Request) {
	var body []typeBody
	if !decode(w, r, &body) {
		return
	}
	var ids []int64
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		for _, b := range body {
			if b.Key == "" || b.Name == "" {
				return httpx.Validation("a distribution set type needs a key and a name")
			}
			id, err := a.st.CreateDSType(r.Context(), tx, user(r), now,
				model.DSType{Key: b.Key, Name: b.Name, Description: str(b.Description), Colour: b.Colour})
			if err != nil {
				return err
			}
			for _, m := range b.Mandatory {
				if _, err := a.st.SMType(r.Context(), tx, m.ID); err != nil {
					return err
				}
				if err := a.st.SetDSTypeModuleType(r.Context(), tx, id, m.ID, true); err != nil {
					return err
				}
			}
			for _, m := range b.Optional {
				if _, err := a.st.SMType(r.Context(), tx, m.ID); err != nil {
					return err
				}
				if err := a.st.SetDSTypeModuleType(r.Context(), tx, id, m.ID, false); err != nil {
					return err
				}
			}
			ids = append(ids, id)
		}
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	out := []J{}
	for _, id := range ids {
		if t, err := a.st.DSType(r.Context(), a.st.DB(), id); err == nil {
			out = append(out, dsTypeJSON(a.base(r), t, false))
		}
	}
	sendCreated(w, out)
}

func (a *API) dsTypeOf(w http.ResponseWriter, r *http.Request) (model.DSType, bool) {
	tid, found := pathID(w, r, "dstId", "DistributionSetType")
	if !found {
		return model.DSType{}, false
	}
	t, err := a.st.DSType(r.Context(), a.st.DB(), tid)
	if err != nil {
		fail(w, err)
		return t, false
	}
	return t, true
}

func (a *API) getDSType(w http.ResponseWriter, r *http.Request) {
	if t, found := a.dsTypeOf(w, r); found {
		sendOK(w, dsTypeJSON(a.base(r), t, true))
	}
}

func (a *API) updateDSType(w http.ResponseWriter, r *http.Request) {
	var body typeBody
	if !decode(w, r, &body) {
		return
	}
	t, found := a.dsTypeOf(w, r)
	if !found {
		return
	}
	if body.Description != nil {
		t.Description = *body.Description
	}
	if body.Colour != nil {
		t.Colour = body.Colour
	}
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		if err := a.st.UpdateDSType(r.Context(), tx, user(r), now, t); err != nil {
			return err
		}
		var err error
		t, err = a.st.DSType(r.Context(), tx, t.ID)
		return err
	})
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, dsTypeJSON(a.base(r), t, true))
}

func (a *API) deleteDSType(w http.ResponseWriter, r *http.Request) {
	t, found := a.dsTypeOf(w, r)
	if !found {
		return
	}
	if err := a.tx(r, func(tx pgx.Tx, now int64) error { return a.st.DeleteDSType(r.Context(), tx, t.ID) }); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) dsTypeModules(mandatory bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, found := a.dsTypeOf(w, r)
		if !found {
			return
		}
		types, err := a.st.DSTypeModuleTypes(r.Context(), a.st.DB(), t.ID, mandatory)
		if err != nil {
			fail(w, err)
			return
		}
		out := make([]J, 0, len(types))
		for _, st := range types {
			out = append(out, smTypeJSON(a.base(r), st))
		}
		sendOK(w, out)
	}
}

func (a *API) dsTypeModule(mandatory bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, found := a.dsTypeOf(w, r)
		if !found {
			return
		}
		smt, found := pathID(w, r, "smtId", "SoftwareModuleType")
		if !found {
			return
		}
		types, err := a.st.DSTypeModuleTypes(r.Context(), a.st.DB(), t.ID, mandatory)
		if err != nil {
			fail(w, err)
			return
		}
		for _, st := range types {
			if st.ID == smt {
				sendOK(w, smTypeJSON(a.base(r), st))
				return
			}
		}
		fail(w, httpx.NotFound("SoftwareModuleType", smt))
	}
}

func (a *API) addDSTypeModule(mandatory bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, found := a.dsTypeOf(w, r)
		if !found {
			return
		}
		var body struct {
			ID int64 `json:"id"`
		}
		if !decode(w, r, &body) {
			return
		}
		err := a.tx(r, func(tx pgx.Tx, now int64) error {
			if _, err := a.st.SMType(r.Context(), tx, body.ID); err != nil {
				return err
			}
			return a.st.SetDSTypeModuleType(r.Context(), tx, t.ID, body.ID, mandatory)
		})
		if err != nil {
			fail(w, err)
			return
		}
		noContent(w)
	}
}

func (a *API) removeDSTypeModule(mandatory bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, found := a.dsTypeOf(w, r)
		if !found {
			return
		}
		smt, found := pathID(w, r, "smtId", "SoftwareModuleType")
		if !found {
			return
		}
		err := a.tx(r, func(tx pgx.Tx, now int64) error {
			removed, err := a.st.RemoveDSTypeModuleType(r.Context(), tx, t.ID, smt, mandatory)
			if err == nil && !removed {
				return httpx.NotFound("SoftwareModuleType", smt)
			}
			return err
		})
		if err != nil {
			fail(w, err)
			return
		}
		noContent(w)
	}
}

// ------------------------------------------------------------- target types

func (a *API) listTargetTypes(w http.ResponseWriter, r *http.Request) {
	p, good := pageOf(w, r)
	if !good {
		return
	}
	ts, total, err := a.st.TargetTypes(r.Context(), p)
	if err != nil {
		fail(w, err)
		return
	}
	b := a.base(r)
	out := make([]map[string]any, 0, len(ts))
	for _, t := range ts {
		out = append(out, targetTypeJSON(b, t, false))
	}
	sendList(w, out, total)
}

// createTargetTypes: hawkBit derives the key from the name when none is
// given, and our start script gives none.
func (a *API) createTargetTypes(w http.ResponseWriter, r *http.Request) {
	var body []typeBody
	if !decode(w, r, &body) {
		return
	}
	var ids []int64
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		for _, b := range body {
			if strings.TrimSpace(b.Name) == "" {
				return httpx.Validation("a target type needs a name")
			}
			key := b.Key
			if key == "" {
				key = b.Name
			}
			id, err := a.st.CreateTargetType(r.Context(), tx, user(r), now,
				model.TargetType{Key: key, Name: b.Name, Description: str(b.Description), Colour: b.Colour})
			if err != nil {
				return err
			}
			for _, c := range b.Compatible {
				if _, err := a.st.DSType(r.Context(), tx, c.ID); err != nil {
					return err
				}
				if err := a.st.AddCompatibleDSType(r.Context(), tx, id, c.ID); err != nil {
					return err
				}
			}
			ids = append(ids, id)
		}
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	out := []J{}
	for _, id := range ids {
		if t, err := a.st.TargetType(r.Context(), a.st.DB(), id); err == nil {
			out = append(out, targetTypeJSON(a.base(r), t, false))
		}
	}
	sendCreated(w, out)
}

func (a *API) targetTypeOf(w http.ResponseWriter, r *http.Request) (model.TargetType, bool) {
	tid, found := pathID(w, r, "ttId", "TargetType")
	if !found {
		return model.TargetType{}, false
	}
	t, err := a.st.TargetType(r.Context(), a.st.DB(), tid)
	if err != nil {
		fail(w, err)
		return t, false
	}
	return t, true
}

func (a *API) getTargetType(w http.ResponseWriter, r *http.Request) {
	if t, found := a.targetTypeOf(w, r); found {
		sendOK(w, targetTypeJSON(a.base(r), t, true))
	}
}

func (a *API) updateTargetType(w http.ResponseWriter, r *http.Request) {
	var body typeBody
	if !decode(w, r, &body) {
		return
	}
	t, found := a.targetTypeOf(w, r)
	if !found {
		return
	}
	if body.Name != "" {
		t.Name = body.Name
	}
	if body.Description != nil {
		t.Description = *body.Description
	}
	if body.Colour != nil {
		t.Colour = body.Colour
	}
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		if err := a.st.UpdateTargetType(r.Context(), tx, user(r), now, t); err != nil {
			return err
		}
		var err error
		t, err = a.st.TargetType(r.Context(), tx, t.ID)
		return err
	})
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, targetTypeJSON(a.base(r), t, true))
}

func (a *API) deleteTargetType(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetTypeOf(w, r)
	if !found {
		return
	}
	if err := a.tx(r, func(tx pgx.Tx, now int64) error { return a.st.DeleteTargetType(r.Context(), tx, t.ID) }); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) compatibleTypes(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetTypeOf(w, r)
	if !found {
		return
	}
	types, err := a.st.CompatibleDSTypes(r.Context(), a.st.DB(), t.ID)
	if err != nil {
		fail(w, err)
		return
	}
	out := make([]J, 0, len(types))
	for _, d := range types {
		out = append(out, dsTypeJSON(a.base(r), d, false))
	}
	sendOK(w, out)
}

func (a *API) addCompatibleTypes(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetTypeOf(w, r)
	if !found {
		return
	}
	var body []struct {
		ID int64 `json:"id"`
	}
	if !decode(w, r, &body) {
		return
	}
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		for _, b := range body {
			if _, err := a.st.DSType(r.Context(), tx, b.ID); err != nil {
				return err
			}
			if err := a.st.AddCompatibleDSType(r.Context(), tx, t.ID, b.ID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) removeCompatibleType(w http.ResponseWriter, r *http.Request) {
	t, found := a.targetTypeOf(w, r)
	if !found {
		return
	}
	dst, found := pathID(w, r, "dstId", "DistributionSetType")
	if !found {
		return
	}
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		removed, err := a.st.RemoveCompatibleDSType(r.Context(), tx, t.ID, dst)
		if err == nil && !removed {
			return httpx.NotFound("DistributionSetType", dst)
		}
		return err
	})
	if err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}
