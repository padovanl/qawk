package ddi

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
)

// An artifact and its checksum sit at paths that differ only by a suffix on
// the last segment, and hawkBit describes them as two operations. chi does
// NOT treat them as two routes: a whole-segment {fileName} wins over
// {fileName}.MD5SUM and swallows the suffix, whichever order they are
// registered in.
//
// That is why one handler serves both and tells them apart by the suffix, and
// why the checksum's route is declared even though nothing ever reaches it --
// the OpenAPI document is built by walking the router, and without the
// declaration the document denied an operation the server performs.
//
// If a future version of chi starts preferring the more specific pattern,
// this test fails, and the handler has to be split. That is the point of it.
func TestChecksumPathReachesTheArtifactHandler(t *testing.T) {
	r := chi.NewRouter()
	var reached bool
	var param string
	r.Route("/{tenant}/controller/v1/{controllerId}", func(r chi.Router) {
		h := func(w http.ResponseWriter, r *http.Request) {
			reached, param = true, chi.URLParam(r, "fileName")
		}
		r.Get("/softwaremodules/{smId}/artifacts/{fileName}", h)
		r.Get("/softwaremodules/{smId}/artifacts/{fileName}.MD5SUM", h)
	})

	for _, c := range []struct{ path, file string }{
		{"/DEFAULT/controller/v1/d1/softwaremodules/8/artifacts/app-1.2.0.swu", "app-1.2.0.swu"},
		// the handler receives the suffix, and is the one that strips it
		{"/DEFAULT/controller/v1/d1/softwaremodules/8/artifacts/app-1.2.0.swu.MD5SUM", "app-1.2.0.swu.MD5SUM"},
		{"/DEFAULT/controller/v1/d1/softwaremodules/8/artifacts/NOTES.MD5SUMS", "NOTES.MD5SUMS"},
	} {
		reached, param = false, ""
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, c.path, nil))
		if w.Code != http.StatusOK || !reached {
			t.Fatalf("%s: status %d, reached %v -- no route matched", c.path, w.Code, reached)
		}
		if param != c.file {
			t.Errorf("%s: fileName %q, want %q", c.path, param, c.file)
		}
	}
}
