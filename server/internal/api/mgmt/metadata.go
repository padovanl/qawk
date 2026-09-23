// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package mgmt

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"qawk/internal/model"
	"qawk/internal/store"
)

// Metadata endpoints are the same for targets, modules and sets; owner finds
// the entity the URL names and returns its id.
type ownerFunc func(w http.ResponseWriter, r *http.Request) (int64, bool)

func (a *API) metadataRoutes(r chi.Router, prefix string, kind store.MetaKind, read, write string, owner ownerFunc) {
	visible := kind == store.MetaSM
	need(r, read).Get(prefix+"/metadata", func(w http.ResponseWriter, r *http.Request) {
		oid, found := owner(w, r)
		if !found {
			return
		}
		p, good := pageOf(w, r)
		if !good {
			return
		}
		ms, total, err := a.st.Metadata(r.Context(), kind, oid, p)
		if err != nil {
			fail(w, err)
			return
		}
		out := make([]map[string]any, 0, len(ms))
		for _, m := range ms {
			out = append(out, metaJSON(m, visible))
		}
		sendList(w, out, total)
	})
	need(r, write).Post(prefix+"/metadata", func(w http.ResponseWriter, r *http.Request) {
		oid, found := owner(w, r)
		if !found {
			return
		}
		var body []struct {
			Key           string `json:"key"`
			Value         string `json:"value"`
			TargetVisible bool   `json:"targetVisible"`
		}
		if !decode(w, r, &body) {
			return
		}
		out := []map[string]any{}
		err := a.tx(r, func(tx pgx.Tx, now int64) error {
			for _, b := range body {
				m := model.Metadata{Key: b.Key, Value: b.Value, TargetVisible: b.TargetVisible}
				if err := a.st.CreateMetadata(r.Context(), tx, kind, oid, m); err != nil {
					return err
				}
				out = append(out, metaJSON(m, visible))
			}
			return nil
		})
		if err != nil {
			fail(w, err)
			return
		}
		sendCreated(w, out)
	})
	need(r, read).Get(prefix+"/metadata/{metadataKey}", func(w http.ResponseWriter, r *http.Request) {
		oid, found := owner(w, r)
		if !found {
			return
		}
		m, err := a.st.MetadataOne(r.Context(), a.st.DB(), kind, oid, chi.URLParam(r, "metadataKey"))
		if err != nil {
			fail(w, err)
			return
		}
		sendOK(w, metaJSON(m, visible))
	})
	need(r, write).Put(prefix+"/metadata/{metadataKey}", func(w http.ResponseWriter, r *http.Request) {
		oid, found := owner(w, r)
		if !found {
			return
		}
		var body struct {
			Value         string `json:"value"`
			TargetVisible *bool  `json:"targetVisible"`
		}
		if !decode(w, r, &body) {
			return
		}
		key := chi.URLParam(r, "metadataKey")
		var m model.Metadata
		err := a.tx(r, func(tx pgx.Tx, now int64) error {
			cur, err := a.st.MetadataOne(r.Context(), tx, kind, oid, key)
			if err != nil {
				return err
			}
			cur.Value = body.Value
			if body.TargetVisible != nil {
				cur.TargetVisible = *body.TargetVisible
			}
			m = cur
			return a.st.UpdateMetadata(r.Context(), tx, kind, oid, cur)
		})
		if err != nil {
			fail(w, err)
			return
		}
		sendOK(w, metaJSON(m, visible))
	})
	need(r, write).Delete(prefix+"/metadata/{metadataKey}", func(w http.ResponseWriter, r *http.Request) {
		oid, found := owner(w, r)
		if !found {
			return
		}
		if err := a.tx(r, func(tx pgx.Tx, now int64) error {
			return a.st.DeleteMetadata(r.Context(), tx, kind, oid, chi.URLParam(r, "metadataKey"))
		}); err != nil {
			fail(w, err)
			return
		}
		noContent(w)
	})
}
