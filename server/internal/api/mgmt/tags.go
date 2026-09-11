package mgmt

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/store"
)

// Target tags and distribution set tags: the same endpoints, two kinds.

func (a *API) tagRoutes(r chi.Router) {
	for _, k := range []struct {
		path       string
		kind       store.TagKind
		read, edit string
	}{
		{"/targettags", store.TagTarget, "READ_TARGET", "UPDATE_TARGET"},
		{"/distributionsettags", store.TagDS, "READ_REPOSITORY", "UPDATE_REPOSITORY"},
	} {
		k := k
		need(r, k.read).Get(k.path, a.listTags(k.kind))
		need(r, k.edit).Post(k.path, a.createTags(k.kind))
		need(r, k.read).Get(k.path+"/{tagId}", a.getTag(k.kind))
		need(r, k.edit).Put(k.path+"/{tagId}", a.updateTag(k.kind))
		need(r, k.edit).Delete(k.path+"/{tagId}", a.deleteTag(k.kind))
		need(r, k.read).Get(k.path+"/{tagId}/assigned", a.tagMembers(k.kind))
		need(r, k.edit).Post(k.path+"/{tagId}/assigned", a.tagAssign(k.kind, true))
		need(r, k.edit).Delete(k.path+"/{tagId}/assigned", a.tagAssign(k.kind, false))
		need(r, k.edit).Post(k.path+"/{tagId}/assigned/{memberId}", a.tagOne(k.kind, true))
		need(r, k.edit).Delete(k.path+"/{tagId}/assigned/{memberId}", a.tagOne(k.kind, false))
	}
}

func (a *API) tagOf(w http.ResponseWriter, r *http.Request, kind store.TagKind) (model.Tag, bool) {
	tid, found := pathID(w, r, "tagId", map[store.TagKind]string{store.TagTarget: "TargetTag", store.TagDS: "DistributionSetTag"}[kind])
	if !found {
		return model.Tag{}, false
	}
	t, err := a.st.Tag(r.Context(), a.st.DB(), kind, tid)
	if err != nil {
		fail(w, err)
		return t, false
	}
	return t, true
}

func (a *API) listTags(kind store.TagKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		p, good := pageOf(w, r)
		if !good {
			return
		}
		tags, total, err := a.st.Tags(r.Context(), kind, p)
		if err != nil {
			fail(w, err)
			return
		}
		b := a.base(r)
		out := make([]map[string]any, 0, len(tags))
		for _, t := range tags {
			out = append(out, tagJSON(b, kind, t, false))
		}
		sendList(w, out, total)
	}
}

type tagBody struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
	Colour      *string `json:"colour"`
}

func (a *API) createTags(kind store.TagKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body []tagBody
		if !decode(w, r, &body) {
			return
		}
		var ids []int64
		err := a.tx(r, func(tx pgx.Tx, now int64) error {
			for _, b := range body {
				if str(b.Name) == "" {
					return httpx.Validation("a tag needs a name")
				}
				id, err := a.st.CreateTag(r.Context(), tx, kind, user(r), now,
					model.Tag{Name: *b.Name, Description: str(b.Description), Colour: b.Colour})
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
			if t, err := a.st.Tag(r.Context(), a.st.DB(), kind, id); err == nil {
				out = append(out, tagJSON(a.base(r), kind, t, false))
			}
		}
		sendCreated(w, out)
	}
}

func (a *API) getTag(kind store.TagKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if t, found := a.tagOf(w, r, kind); found {
			sendOK(w, tagJSON(a.base(r), kind, t, true))
		}
	}
}

func (a *API) updateTag(kind store.TagKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var body tagBody
		if !decode(w, r, &body) {
			return
		}
		t, found := a.tagOf(w, r, kind)
		if !found {
			return
		}
		if body.Name != nil {
			t.Name = *body.Name
		}
		if body.Description != nil {
			t.Description = *body.Description
		}
		if body.Colour != nil {
			t.Colour = body.Colour
		}
		err := a.tx(r, func(tx pgx.Tx, now int64) error {
			if err := a.st.UpdateTag(r.Context(), tx, kind, user(r), now, t); err != nil {
				return err
			}
			var err error
			t, err = a.st.Tag(r.Context(), tx, kind, t.ID)
			return err
		})
		if err != nil {
			fail(w, err)
			return
		}
		sendOK(w, tagJSON(a.base(r), kind, t, true))
	}
}

func (a *API) deleteTag(kind store.TagKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, found := a.tagOf(w, r, kind)
		if !found {
			return
		}
		if err := a.tx(r, func(tx pgx.Tx, now int64) error { return a.st.DeleteTag(r.Context(), tx, kind, t.ID) }); err != nil {
			fail(w, err)
			return
		}
		noContent(w)
	}
}

func (a *API) tagMembers(kind store.TagKind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, found := a.tagOf(w, r, kind)
		if !found {
			return
		}
		if kind == store.TagTarget {
			a.sendTargets(w, r, store.TagMembers(kind, t.ID, "t"))
			return
		}
		p, good := pageOf(w, r)
		if !good {
			return
		}
		sets, total, err := a.st.DistributionSets(r.Context(), p, store.TagMembers(kind, t.ID, "d"))
		if err != nil {
			fail(w, err)
			return
		}
		b := a.base(r)
		out := make([]map[string]any, 0, len(sets))
		for _, ds := range sets {
			out = append(out, dsJSON(b, ds, false))
		}
		sendList(w, out, total)
	}
}

// members reads a list of members: controller ids for target tags, set ids
// for set tags. The console sends ["id", ...]; older clients send
// [{"controllerId": "id"}] or [{"id": 1}], and all three are accepted.
func (a *API) members(w http.ResponseWriter, r *http.Request, kind store.TagKind) ([]int64, bool) {
	var raw []json.RawMessage
	if !decode(w, r, &raw) {
		return nil, false
	}
	ids := make([]int64, 0, len(raw))
	for _, m := range raw {
		var s string
		var n int64
		var obj struct {
			ControllerID string   `json:"controllerId"`
			ID           json_raw `json:"id"`
		}
		var key string
		switch {
		case json.Unmarshal(m, &s) == nil:
			key = s
		case json.Unmarshal(m, &n) == nil:
			key = ""
			ids = append(ids, n)
			continue
		case json.Unmarshal(m, &obj) == nil:
			key = obj.ControllerID
			if key == "" {
				key = obj.ID.String()
			}
		}
		if kind == store.TagTarget {
			t, err := a.st.Target(r.Context(), a.st.DB(), key)
			if err != nil {
				fail(w, err)
				return nil, false
			}
			ids = append(ids, t.ID)
		} else {
			var id json_raw
			_ = id.UnmarshalJSON([]byte(`"` + key + `"`))
			v, err := id.Int()
			if err != nil {
				fail(w, httpx.NotFound("DistributionSet", key))
				return nil, false
			}
			ids = append(ids, v)
		}
	}
	return ids, true
}

func (a *API) tagAssign(kind store.TagKind, assign bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, found := a.tagOf(w, r, kind)
		if !found {
			return
		}
		ids, found := a.members(w, r, kind)
		if !found {
			return
		}
		a.applyTag(w, r, kind, t.ID, ids, assign)
	}
}

func (a *API) tagOne(kind store.TagKind, assign bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		t, found := a.tagOf(w, r, kind)
		if !found {
			return
		}
		m := chi.URLParam(r, "memberId")
		var mid int64
		if kind == store.TagTarget {
			tg, err := a.st.Target(r.Context(), a.st.DB(), m)
			if err != nil {
				fail(w, err)
				return
			}
			mid = tg.ID
		} else {
			v, found := pathID(w, r, "memberId", "DistributionSet")
			if !found {
				return
			}
			mid = v
		}
		a.applyTag(w, r, kind, t.ID, []int64{mid}, assign)
	}
}

func (a *API) applyTag(w http.ResponseWriter, r *http.Request, kind store.TagKind, tagID int64, ids []int64, assign bool) {
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		if assign {
			return a.st.AssignTag(r.Context(), tx, kind, tagID, ids)
		}
		return a.st.UnassignTag(r.Context(), tx, kind, tagID, ids)
	})
	if err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}
