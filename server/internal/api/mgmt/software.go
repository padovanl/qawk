package mgmt

import (
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/store"
)

func (a *API) softwareRoutes(r chi.Router) {
	need(r, "READ_REPOSITORY").Get("/softwaremodules", a.listModules)
	need(r, "CREATE_REPOSITORY").Post("/softwaremodules", a.createModules)
	need(r, "READ_REPOSITORY").Get("/softwaremodules/{smId}", a.getModule)
	need(r, "UPDATE_REPOSITORY").Put("/softwaremodules/{smId}", a.updateModule)
	need(r, "DELETE_REPOSITORY").Delete("/softwaremodules/{smId}", a.deleteModule)
	need(r, "READ_REPOSITORY").Get("/softwaremodules/{smId}/artifacts", a.listArtifacts)
	need(r, "CREATE_REPOSITORY").Post("/softwaremodules/{smId}/artifacts", a.uploadArtifact)
	need(r, "READ_REPOSITORY").Get("/softwaremodules/{smId}/artifacts/{artifactId}", a.getArtifact)
	need(r, "DELETE_REPOSITORY").Delete("/softwaremodules/{smId}/artifacts/{artifactId}", a.deleteArtifact)
	need(r, "DOWNLOAD_REPOSITORY_ARTIFACT").Get("/softwaremodules/{smId}/artifacts/{artifactId}/download", a.downloadArtifact)
	a.metadataRoutes(r, "/softwaremodules/{smId}", store.MetaSM, "READ_REPOSITORY", "UPDATE_REPOSITORY", a.moduleOwner)
}

func (a *API) moduleOf(w http.ResponseWriter, r *http.Request) (model.SoftwareModule, bool) {
	smID, found := pathID(w, r, "smId", "SoftwareModule")
	if !found {
		return model.SoftwareModule{}, false
	}
	m, err := a.st.SoftwareModule(r.Context(), a.st.DB(), smID)
	if err != nil {
		fail(w, err)
		return m, false
	}
	return m, true
}

func (a *API) moduleOwner(w http.ResponseWriter, r *http.Request) (int64, bool) {
	m, found := a.moduleOf(w, r)
	return m.ID, found
}

func (a *API) listModules(w http.ResponseWriter, r *http.Request) {
	p, good := pageOf(w, r)
	if !good {
		return
	}
	ms, total, err := a.st.SoftwareModules(r.Context(), p)
	if err != nil {
		fail(w, err)
		return
	}
	b := a.base(r)
	out := make([]map[string]any, 0, len(ms))
	for _, m := range ms {
		out = append(out, smJSON(b, m, false))
	}
	sendList(w, out, total)
}

func (a *API) createModules(w http.ResponseWriter, r *http.Request) {
	var body []struct {
		Name        string `json:"name"`
		Version     string `json:"version"`
		Type        string `json:"type"`
		Description string `json:"description"`
		Vendor      string `json:"vendor"`
		Encrypted   bool   `json:"encrypted"`
	}
	if !decode(w, r, &body) {
		return
	}
	var ids []int64
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		for _, b := range body {
			if strings.TrimSpace(b.Name) == "" || strings.TrimSpace(b.Version) == "" || b.Type == "" {
				return httpx.Validation("a software module needs a name, a version and a type")
			}
			t, err := a.st.SMTypeByKey(r.Context(), tx, b.Type)
			if err != nil {
				return err
			}
			id, err := a.st.CreateSM(r.Context(), tx, user(r), now, model.SoftwareModule{TypeID: t.ID, Name: b.Name,
				Version: b.Version, Description: b.Description, Vendor: b.Vendor, Encrypted: b.Encrypted})
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
	base := a.base(r)
	out := []map[string]any{}
	for _, id := range ids {
		if m, err := a.st.SoftwareModule(r.Context(), a.st.DB(), id); err == nil {
			out = append(out, smJSON(base, m, false))
		}
	}
	sendCreated(w, out)
}

func (a *API) getModule(w http.ResponseWriter, r *http.Request) {
	if m, found := a.moduleOf(w, r); found {
		sendOK(w, smJSON(a.base(r), m, true))
	}
}

func (a *API) updateModule(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Description *string `json:"description"`
		Vendor      *string `json:"vendor"`
		Locked      *bool   `json:"locked"`
	}
	if !decode(w, r, &body) {
		return
	}
	m, found := a.moduleOf(w, r)
	if !found {
		return
	}
	if body.Description != nil {
		m.Description = *body.Description
	}
	if body.Vendor != nil {
		m.Vendor = *body.Vendor
	}
	if body.Locked != nil {
		m.Locked = *body.Locked
	}
	err := a.tx(r, func(tx pgx.Tx, now int64) error {
		if err := a.st.UpdateSM(r.Context(), tx, user(r), now, m); err != nil {
			return err
		}
		var err error
		m, err = a.st.SoftwareModule(r.Context(), tx, m.ID)
		return err
	})
	if err != nil {
		fail(w, err)
		return
	}
	sendOK(w, smJSON(a.base(r), m, true))
}

func (a *API) deleteModule(w http.ResponseWriter, r *http.Request) {
	smID, found := pathID(w, r, "smId", "SoftwareModule")
	if !found {
		return
	}
	if err := a.svc.DeleteModule(r.Context(), user(r), smID); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

// ------------------------------------------------------------------ artifacts

func (a *API) listArtifacts(w http.ResponseWriter, r *http.Request) {
	m, found := a.moduleOf(w, r)
	if !found {
		return
	}
	arts, err := a.st.Artifacts(r.Context(), a.st.DB(), m.ID)
	if err != nil {
		fail(w, err)
		return
	}
	b := a.base(r)
	out := make([]J, 0, len(arts))
	for _, art := range arts {
		out = append(out, artifactJSON(b, art, false))
	}
	sendOK(w, out)
}

// uploadArtifact reads the multipart body as a stream: a system image is
// over half a gigabyte, and holding it in memory to parse the form would be
// the first thing to fall over. Fields that come before the file (filename,
// md5sum, sha1sum, sha256sum) are honoured; the file itself goes straight
// into the artifact store, hashed on the way.
func (a *API) uploadArtifact(w http.ResponseWriter, r *http.Request) {
	smID, found := pathID(w, r, "smId", "SoftwareModule")
	if !found {
		return
	}
	mr, err := r.MultipartReader()
	if err != nil {
		fail(w, httpx.NotReadable())
		return
	}
	fields := map[string]string{}
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			fail(w, httpx.NotReadable())
			return
		}
		if part.FormName() != "file" {
			v, _ := io.ReadAll(io.LimitReader(part, 4096))
			fields[part.FormName()] = strings.TrimSpace(string(v))
			part.Close()
			continue
		}
		name := fields["filename"]
		if name == "" {
			name = part.FileName()
		}
		if name == "" {
			fail(w, httpx.Validation("the artifact has no file name"))
			return
		}
		art, err := a.svc.UploadArtifact(r.Context(), user(r), smID, name, part,
			fields["md5sum"], fields["sha1sum"], fields["sha256sum"])
		part.Close()
		if err != nil {
			fail(w, err)
			return
		}
		sendCreated(w, artifactJSON(a.base(r), art, true))
		return
	}
	fail(w, httpx.Custom(400, "hawkbit.server.error.artifact.uploadFailed",
		"org.eclipse.hawkbit.repository.exception.ArtifactUploadFailedException", "the request carries no 'file' part"))
}

func (a *API) artifactOf(w http.ResponseWriter, r *http.Request) (model.Artifact, bool) {
	m, found := a.moduleOf(w, r)
	if !found {
		return model.Artifact{}, false
	}
	artID, found := pathID(w, r, "artifactId", "Artifact")
	if !found {
		return model.Artifact{}, false
	}
	art, err := a.st.Artifact(r.Context(), a.st.DB(), m.ID, artID)
	if err != nil {
		fail(w, err)
		return art, false
	}
	return art, true
}

func (a *API) getArtifact(w http.ResponseWriter, r *http.Request) {
	if art, found := a.artifactOf(w, r); found {
		sendOK(w, artifactJSON(a.base(r), art, true))
	}
}

func (a *API) deleteArtifact(w http.ResponseWriter, r *http.Request) {
	art, found := a.artifactOf(w, r)
	if !found {
		return
	}
	if err := a.svc.DeleteArtifact(r.Context(), user(r), art.SMID, art.ID); err != nil {
		fail(w, err)
		return
	}
	noContent(w)
}

func (a *API) downloadArtifact(w http.ResponseWriter, r *http.Request) {
	art, found := a.artifactOf(w, r)
	if !found {
		return
	}
	f, err := a.svc.Artifacts().Open(art.SHA256)
	if err != nil {
		fail(w, httpx.NotFound("Artifact", art.ID))
		return
	}
	defer f.Close()
	w.Header().Set("Content-Disposition", "attachment;filename="+art.Filename)
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("ETag", `"`+art.SHA1+`"`)
	http.ServeContent(w, r, "", time.UnixMilli(art.CreatedAt), f)
}
