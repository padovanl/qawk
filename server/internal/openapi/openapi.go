// Package openapi publishes the API description, where hawkBit publishes it
// (/v3/api-docs/<group>), listing exactly what Qawk implements.
package openapi

import (
	"encoding/json"
	"net/http"
	"regexp"
	"strings"
	"sync"

	"github.com/go-chi/chi/v5"

	"qawk/reference"
)

var param = regexp.MustCompile(`\{[^}]*\}`)

// shape names a path by its structure only: {targetId} and {controllerId} are
// the same slot.
func shape(p string) string { return param.ReplaceAllString(strings.TrimSuffix(p, "/"), "{}") }

// Docs is built once, from the router, the first time it is asked for.
type Docs struct {
	router  chi.Routes
	version string
	once    sync.Once
	docs    map[string][]byte
}

func New(router chi.Routes, version string) *Docs { return &Docs{router: router, version: version} }

func (d *Docs) build() {
	implemented := map[string]map[string]bool{} // shape -> methods
	_ = chi.Walk(d.router, func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		s := shape(route)
		if implemented[s] == nil {
			implemented[s] = map[string]bool{}
		}
		implemented[s][strings.ToLower(method)] = true
		return nil
	})
	d.docs = map[string][]byte{}
	for name, src := range map[string][]byte{
		"Management API":                     reference.ManagementAPI,
		"Direct Device Integration API":      reference.DDIAPI,
	} {
		var doc map[string]any
		if err := json.Unmarshal(src, &doc); err != nil {
			continue
		}
		paths, _ := doc["paths"].(map[string]any)
		kept := map[string]any{}
		for p, ops := range paths {
			have := implemented[shape(p)]
			if have == nil {
				continue
			}
			opm, _ := ops.(map[string]any)
			k := map[string]any{}
			for m, op := range opm {
				if have[m] {
					k[m] = op
				}
			}
			if len(k) > 0 {
				kept[p] = k
			}
		}
		doc["paths"] = kept
		if info, ok := doc["info"].(map[string]any); ok {
			// "v1" is the API's version, which the console checks; the
			// product is named separately.
			info["x-server"] = "Qawk " + d.version
		}
		b, _ := json.Marshal(doc)
		d.docs[name] = b
	}
}

// Routes mounts /v3/api-docs.
func (d *Docs) Routes(r chi.Router) {
	r.Get("/v3/api-docs/swagger-config", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"urls": []map[string]string{
			{"name": "Direct Device Integration API", "url": "/v3/api-docs/Direct Device Integration API"},
			{"name": "Management API", "url": "/v3/api-docs/Management API"},
		}})
	})
	r.Get("/v3/api-docs/{group}", func(w http.ResponseWriter, r *http.Request) {
		d.once.Do(d.build)
		b, ok := d.docs[chi.URLParam(r, "group")]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
	})
}
