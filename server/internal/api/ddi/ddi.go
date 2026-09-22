// Package ddi is hawkBit's Direct Device Integration API: what a device --
// SWUpdate's suricatta on our images -- talks to.
//
// This is the one part of Qawk that must not differ from hawkBit in any way a
// device could notice. The image is frozen: SWUpdate will keep sending the
// requests it sends today, and reading the answers the way it reads hawkBit's.
// The recorded samples in reference/samples are the contract.
package ddi

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"qawk/internal/auth"
	"qawk/internal/httpx"
	"qawk/internal/model"
	"qawk/internal/service"
	"qawk/internal/store"
)

type API struct {
	svc       *service.Service
	st        *store.Store
	tenant    string
	publicURL string
	log       *slog.Logger
}

func New(svc *service.Service, tenant, publicURL string, log *slog.Logger) *API {
	return &API{svc: svc, st: svc.Store(), tenant: tenant, publicURL: publicURL, log: log}
}

// Routes mounts the DDI under /{tenant}/controller/v1.
func (a *API) Routes(r chi.Router) {
	r.Route("/{tenant}/controller/v1/{controllerId}", func(r chi.Router) {
		r.Use(a.authenticate)
		r.Get("/", a.root)
		r.Get("/deploymentBase/{actionId}", a.deploymentBase)
		r.Post("/deploymentBase/{actionId}/feedback", a.deploymentFeedback)
		r.Get("/cancelAction/{actionId}", a.cancelAction)
		r.Post("/cancelAction/{actionId}/feedback", a.cancelFeedback)
		r.Put("/configData", a.configData)
		r.Get("/installedBase/{actionId}", a.installedBase)
		r.Put("/installedBase", a.setInstalled)
		r.Get("/confirmationBase", a.confirmationBase)
		r.Get("/confirmationBase/{actionId}", a.confirmationAction)
		r.Post("/confirmationBase/{actionId}/feedback", a.confirmationFeedback)
		r.Post("/confirmationBase/activateAutoConfirm", a.activateAutoConfirm)
		r.Post("/confirmationBase/deactivateAutoConfirm", a.deactivateAutoConfirm)
		r.Get("/softwaremodules/{smId}/artifacts", a.artifacts)
		r.Get("/softwaremodules/{smId}/artifacts/{fileName}", a.download)
		r.Head("/softwaremodules/{smId}/artifacts/{fileName}", a.download)
		// hawkBit publishes an artifact's checksum at a path of its own, and
		// this declares it -- but the requests never arrive here: chi prefers
		// the plain {fileName} above, which swallows the ".MD5SUM" whole, and
		// the handler tells the two apart by the suffix (see routes_test.go,
		// which pins that down).
		//
		// So why declare it? The OpenAPI document is built by walking the
		// router. Without this line the checksum operation was missing from
		// the document although the server served it perfectly, and the
		// document is what a generated client is built from. Do not "clean up"
		// this route: it is what makes the server's description true.
		r.Get("/softwaremodules/{smId}/artifacts/{fileName}.MD5SUM", a.download)
		r.Head("/softwaremodules/{smId}/artifacts/{fileName}.MD5SUM", a.download)
	})
}

// ------------------------------------------------------------- authentication

type ctxTarget struct{}

// authenticate checks the tenant and the device's credentials, in hawkBit's
// order: a target token (the device's own secret), then the gateway token
// (one secret for the whole fleet -- what our images use), then anonymous
// access if it is enabled. Anything else is a bare 401, which is what hawkBit
// answers and what SWUpdate expects.
func (a *API) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.EqualFold(chi.URLParam(r, "tenant"), a.tenant) {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		ctx := r.Context()
		scheme, token, _ := strings.Cut(r.Header.Get("Authorization"), " ")
		token = strings.TrimSpace(token)
		ok := false
		switch strings.ToLower(scheme) {
		case "targettoken":
			if token != "" && a.st.ConfigBool(ctx, "authentication.targettoken.enabled") {
				if t, err := a.st.Target(ctx, a.st.DB(), chi.URLParam(r, "controllerId")); err == nil {
					ok = subtle.ConstantTimeCompare([]byte(token), []byte(t.SecurityToken)) == 1
				}
			}
		case "gatewaytoken":
			if token != "" && a.st.ConfigBool(ctx, "authentication.gatewaytoken.enabled") {
				key := a.st.ConfigString(ctx, "authentication.gatewaytoken.key")
				ok = key != "" && subtle.ConstantTimeCompare([]byte(token), []byte(key)) == 1
			}
		}
		if !ok && a.st.ConfigBool(ctx, "authentication.anonymous.enabled") {
			ok = true
		}
		if !ok {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r.WithContext(auth.WithUser(ctx, chi.URLParam(r, "controllerId"))))
	})
}

// target loads the (registered) target named in the URL.
func (a *API) target(w http.ResponseWriter, r *http.Request) (model.Target, bool) {
	t, err := a.st.Target(r.Context(), a.st.DB(), chi.URLParam(r, "controllerId"))
	if err != nil {
		httpx.WriteError(w, err)
		return t, false
	}
	return t, true
}

func actionID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(chi.URLParam(r, "actionId"), 10, 64)
	if err != nil {
		httpx.WriteError(w, httpx.NotFound("Action", chi.URLParam(r, "actionId")))
		return 0, false
	}
	return id, true
}

// base is the root of this controller's links.
func (a *API) base(r *http.Request) string {
	return httpx.Base(r, a.publicURL) + "/" + chi.URLParam(r, "tenant") + "/controller/v1/" + chi.URLParam(r, "controllerId")
}

// remoteAddress is the device's address as hawkBit records it ("http://ip").
func remoteAddress(r *http.Request) *string {
	ip := r.RemoteAddr
	if f := r.Header.Get("X-Forwarded-For"); f != "" {
		ip = strings.TrimSpace(strings.Split(f, ",")[0])
	} else if h, _, err := net.SplitHostPort(ip); err == nil {
		ip = h
	}
	addr := "http://" + ip
	return &addr
}

// ------------------------------------------------------------------- root

func (a *API) root(w http.ResponseWriter, r *http.Request) {
	res, err := a.svc.Poll(r.Context(), chi.URLParam(r, "controllerId"), remoteAddress(r))
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	body := map[string]any{"config": map[string]any{"polling": map[string]any{"sleep": res.Sleep}}}
	links := map[string]httpx.Link{}
	b := a.base(r)
	switch res.Next.Kind {
	case "deploymentBase":
		links["deploymentBase"] = httpx.L(fmt.Sprintf("%s/deploymentBase/%d?c=%d", b, res.Next.ActionID, res.Next.Hash))
	case "cancelAction":
		links["cancelAction"] = httpx.L(fmt.Sprintf("%s/cancelAction/%d", b, res.Next.ActionID))
	case "confirmationBase":
		links["confirmationBase"] = httpx.L(fmt.Sprintf("%s/confirmationBase/%d", b, res.Next.ActionID))
	case "installedBase":
		links["installedBase"] = httpx.L(fmt.Sprintf("%s/installedBase/%d", b, res.Next.ActionID))
	}
	if res.ConfigData {
		links["configData"] = httpx.L(b + "/configData")
	}
	if len(links) > 0 {
		body["_links"] = links
	}
	httpx.WriteJSON(w, http.StatusOK, body)
}

// ------------------------------------------------------------- deployments

type ddiArtifact struct {
	Filename string                `json:"filename"`
	Hashes   map[string]string     `json:"hashes"`
	Size     int64                 `json:"size"`
	Links    map[string]httpx.Link `json:"_links"`
}

type ddiChunk struct {
	Part      string              `json:"part"`
	Version   string              `json:"version"`
	Name      string              `json:"name"`
	Artifacts []ddiArtifact       `json:"artifacts"`
	Metadata  []map[string]string `json:"metadata,omitempty"`
}

func (a *API) artifactJSON(b string, smID int64, art model.Artifact) ddiArtifact {
	href := fmt.Sprintf("%s/softwaremodules/%d/artifacts/%s", b, smID, art.Filename)
	return ddiArtifact{
		Filename: art.Filename,
		Hashes:   map[string]string{"sha1": art.SHA1, "md5": art.MD5, "sha256": art.SHA256},
		Size:     art.Size,
		Links: map[string]httpx.Link{
			"download-http": httpx.L(href),
			"md5sum-http":   httpx.L(href + ".MD5SUM"),
		},
	}
}

func (a *API) deploymentJSON(r *http.Request, d service.Deployment) map[string]any {
	b := a.base(r)
	chunks := make([]ddiChunk, 0, len(d.Chunks))
	for _, c := range d.Chunks {
		arts := make([]ddiArtifact, 0, len(c.Artifacts))
		for _, art := range c.Artifacts {
			arts = append(arts, a.artifactJSON(b, c.ModuleID, art))
		}
		ch := ddiChunk{Part: c.Part, Version: c.Version, Name: c.Name, Artifacts: arts}
		for _, m := range c.Metadata {
			ch.Metadata = append(ch.Metadata, map[string]string{"key": m.Key, "value": m.Value})
		}
		chunks = append(chunks, ch)
	}
	dep := map[string]any{"download": d.Download, "update": d.Update, "chunks": chunks}
	if d.MaintenanceWindow != "" {
		dep["maintenanceWindow"] = d.MaintenanceWindow
	}
	return map[string]any{"id": strconv.FormatInt(d.Action.ID, 10), "deployment": dep}
}

func (a *API) deploymentBase(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r)
	if !ok {
		return
	}
	id, ok := actionID(w, r)
	if !ok {
		return
	}
	d, err := a.svc.DeploymentBase(r.Context(), t, id, false)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, a.deploymentJSON(r, d))
}

func (a *API) installedBase(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r)
	if !ok {
		return
	}
	id, ok := actionID(w, r)
	if !ok {
		return
	}
	d, err := a.svc.DeploymentBase(r.Context(), t, id, true)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, a.deploymentJSON(r, d))
}

// feedbackBody is DdiActionFeedback.
type feedbackBody struct {
	Time   string `json:"time"`
	Status *struct {
		Execution string `json:"execution"`
		Result    *struct {
			Finished string `json:"finished"`
		} `json:"result"`
		Details []string `json:"details"`
		Code    *int     `json:"code"`
	} `json:"status"`
}

func parseFeedback(r *http.Request) (service.Feedback, *httpx.Error) {
	var body feedbackBody
	if e := httpx.Decode(r, &body); e != nil {
		return service.Feedback{}, e
	}
	if body.Status == nil || body.Status.Execution == "" {
		return service.Feedback{}, httpx.NotReadable()
	}
	f := service.Feedback{Execution: body.Status.Execution, Details: body.Status.Details, Code: body.Status.Code}
	if body.Status.Result != nil {
		f.Finished = body.Status.Result.Finished
	}
	// hawkBit's time format: 20140511T121314 (UTC)
	if body.Time != "" {
		if tm, err := time.Parse("20060102T150405", body.Time); err == nil {
			f.Time = tm.UnixMilli()
		}
	}
	return f, nil
}

// empty200 is hawkBit's answer to a report: 200 and no body.
func empty200(w http.ResponseWriter) {
	w.Header().Set("Content-Length", "0")
	w.WriteHeader(http.StatusOK)
}

func writeFeedbackError(w http.ResponseWriter, err error) {
	if errors.Is(err, service.ErrGone) {
		w.WriteHeader(http.StatusGone)
		return
	}
	httpx.WriteError(w, err)
}

func (a *API) deploymentFeedback(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r)
	if !ok {
		return
	}
	id, ok := actionID(w, r)
	if !ok {
		return
	}
	f, e := parseFeedback(r)
	if e != nil {
		httpx.WriteError(w, e)
		return
	}
	if err := a.svc.DeploymentFeedback(r.Context(), t, id, f); err != nil {
		writeFeedbackError(w, err)
		return
	}
	empty200(w)
}

func (a *API) cancelAction(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r)
	if !ok {
		return
	}
	id, ok := actionID(w, r)
	if !ok {
		return
	}
	act, err := a.svc.CancelBase(r.Context(), t, id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	sid := strconv.FormatInt(act.ID, 10)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"id": sid, "cancelAction": map[string]string{"stopId": sid}})
}

func (a *API) cancelFeedback(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r)
	if !ok {
		return
	}
	id, ok := actionID(w, r)
	if !ok {
		return
	}
	f, e := parseFeedback(r)
	if e != nil {
		httpx.WriteError(w, e)
		return
	}
	if err := a.svc.CancelFeedback(r.Context(), t, id, f); err != nil {
		writeFeedbackError(w, err)
		return
	}
	empty200(w)
}

func (a *API) configData(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r)
	if !ok {
		return
	}
	var body struct {
		Mode string            `json:"mode"`
		Data map[string]string `json:"data"`
	}
	if e := httpx.Decode(r, &body); e != nil || body.Data == nil {
		httpx.WriteError(w, httpx.NotReadable())
		return
	}
	if body.Mode == "" {
		body.Mode = "merge"
	}
	if err := a.svc.ConfigData(r.Context(), t, body.Mode, body.Data); err != nil {
		httpx.WriteError(w, err)
		return
	}
	empty200(w)
}

// setInstalled is "set offline assigned version": the device reports it
// already runs a set, installed some other way. The set is assigned and an
// action recorded as finished, so the server's view matches the device.
func (a *API) setInstalled(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r)
	if !ok {
		return
	}
	var body struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	}
	if e := httpx.Decode(r, &body); e != nil || body.Name == "" || body.Version == "" {
		httpx.WriteError(w, httpx.NotReadable())
		return
	}
	id, err := a.svc.OfflineInstalled(r.Context(), t, body.Name, body.Version)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"id": strconv.FormatInt(id, 10)})
}

// ------------------------------------------------------------ confirmation

func (a *API) confirmationBase(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r)
	if !ok {
		return
	}
	b := a.base(r)
	links := map[string]httpx.Link{}
	auto := map[string]any{"active": t.AutoConfirmActive}
	if t.AutoConfirmActive {
		links["deactivateAutoConfirm"] = httpx.L(b + "/confirmationBase/deactivateAutoConfirm")
		if t.AutoConfirmInitiator != nil {
			auto["initiator"] = *t.AutoConfirmInitiator
		}
		if t.AutoConfirmRemark != nil {
			auto["remark"] = *t.AutoConfirmRemark
		}
		if t.AutoConfirmAt != nil {
			auto["activatedAt"] = *t.AutoConfirmAt
		}
	} else {
		links["activateAutoConfirm"] = httpx.L(b + "/confirmationBase/activateAutoConfirm")
	}
	actives, err := a.st.ActiveActions(r.Context(), a.st.DB(), t.ID)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	for _, act := range actives {
		if act.Status == model.StatusWaitForConfirmation {
			links["confirmationBase"] = httpx.L(fmt.Sprintf("%s/confirmationBase/%d", b, act.ID))
			break
		}
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"autoConfirm": auto, "_links": links})
}

func (a *API) confirmationAction(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r)
	if !ok {
		return
	}
	id, ok := actionID(w, r)
	if !ok {
		return
	}
	act, err := a.st.ActionOf(r.Context(), a.st.DB(), t.ID, id)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	if act.Status != model.StatusWaitForConfirmation {
		httpx.WriteError(w, httpx.NotFound("Action", id))
		return
	}
	d, err := a.svc.DeploymentBase(r.Context(), t, id, false)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	dep := a.deploymentJSON(r, d)
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"id": dep["id"], "confirmation": dep["deployment"]})
}

func (a *API) confirmationFeedback(w http.ResponseWriter, r *http.Request) {
	t, ok := a.target(w, r)
	if !ok {
		return
	}
	id, ok := actionID(w, r)
	if !ok {
		return
	}
	var body struct {
		Confirmation string   `json:"confirmation"`
		Code         *int     `json:"code"`
		Details      []string `json:"details"`
	}
	if e := httpx.Decode(r, &body); e != nil {
		httpx.WriteError(w, e)
		return
	}
	var confirmed bool
	switch strings.ToLower(body.Confirmation) {
	case "confirmed":
		confirmed = true
	case "denied":
	default:
		httpx.WriteError(w, httpx.NotReadable())
		return
	}
	if err := a.svc.Confirm(r.Context(), t, id, confirmed, body.Code, body.Details); err != nil {
		writeFeedbackError(w, err)
		return
	}
	empty200(w)
}

func (a *API) activateAutoConfirm(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Initiator *string `json:"initiator"`
		Remark    *string `json:"remark"`
	}
	_ = httpx.Decode(r, &body) // the body is optional
	id := chi.URLParam(r, "controllerId")
	if err := a.svc.SetAutoConfirm(r.Context(), id, id, true, body.Initiator, body.Remark); err != nil {
		httpx.WriteError(w, err)
		return
	}
	empty200(w)
}

func (a *API) deactivateAutoConfirm(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "controllerId")
	if err := a.svc.SetAutoConfirm(r.Context(), id, id, false, nil, nil); err != nil {
		httpx.WriteError(w, err)
		return
	}
	empty200(w)
}

// --------------------------------------------------------------- downloads

func (a *API) module(w http.ResponseWriter, r *http.Request) (model.Target, int64, bool) {
	t, ok := a.target(w, r)
	if !ok {
		return t, 0, false
	}
	smID, err := strconv.ParseInt(chi.URLParam(r, "smId"), 10, 64)
	if err != nil {
		httpx.WriteError(w, httpx.NotFound("SoftwareModule", chi.URLParam(r, "smId")))
		return t, 0, false
	}
	mine, err := a.svc.ModuleOfTarget(r.Context(), t, smID)
	if err != nil {
		httpx.WriteError(w, err)
		return t, 0, false
	}
	if !mine {
		httpx.WriteError(w, httpx.NotFound("SoftwareModule", smID))
		return t, 0, false
	}
	return t, smID, true
}

func (a *API) artifacts(w http.ResponseWriter, r *http.Request) {
	_, smID, ok := a.module(w, r)
	if !ok {
		return
	}
	arts, err := a.st.Artifacts(r.Context(), a.st.DB(), smID)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	b := a.base(r)
	out := make([]ddiArtifact, 0, len(arts))
	for _, art := range arts {
		out = append(out, a.artifactJSON(b, smID, art))
	}
	httpx.WriteJSON(w, http.StatusOK, out)
}

// download serves an artifact, or its .MD5SUM, with the headers hawkBit
// sends: ETag (the SHA-1), Last-Modified, Accept-Ranges. Ranges, HEAD and
// If-Range come from http.ServeContent, which is what makes a resumed
// download and a delta's hundreds of range requests work.
func (a *API) download(w http.ResponseWriter, r *http.Request) {
	t, smID, ok := a.module(w, r)
	if !ok {
		return
	}
	// One handler for both paths: chi sends the checksum's requests here too,
	// with the suffix still on the name.
	name := chi.URLParam(r, "fileName")
	md5sum := strings.HasSuffix(name, ".MD5SUM")
	lookup := strings.TrimSuffix(name, ".MD5SUM")
	art, err := a.st.ArtifactByName(r.Context(), a.st.DB(), smID, lookup)
	if err != nil {
		httpx.WriteError(w, err)
		return
	}
	var actionID int64
	rng := r.Header.Get("Range")
	ranged := rng != ""
	if r.Method == http.MethodGet {
		fromStart := rng == "" || strings.HasPrefix(rng, "bytes=0-")
		var err error
		actionID, err = a.svc.BeginDownload(context.WithoutCancel(r.Context()), t, smID, art, r.URL.Path,
			ranged, fromStart, !md5sum)
		if err != nil {
			a.log.Warn("recording a download", "target", t.ControllerID, "err", err)
		}
	}
	w.Header().Set("Content-Disposition", "attachment;filename="+name)
	if md5sum {
		body := art.MD5 + "  " + art.Filename
		w.Header().Set("Content-Type", "text/plain")
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(http.StatusOK)
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(body))
		}
		return
	}
	f, err := a.svc.Artifacts().Open(art.SHA256)
	if err != nil {
		a.log.Error("artifact missing from the store", "sha256", art.SHA256, "err", err)
		httpx.WriteError(w, httpx.NotFound("Artifact", art.Filename))
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("ETag", `"`+art.SHA1+`"`)
	w.Header().Set("Accept-Ranges", "bytes")
	if actionID == 0 {
		http.ServeContent(w, r, "", time.UnixMilli(art.CreatedAt), f)
		return
	}
	// Count what leaves, so the console can say how far the device has got
	// -- and, once the last byte of a whole file is out, that it is
	// installing. Saved every two seconds, and at the end.
	ctx := context.WithoutCancel(r.Context())
	pw := &progressWriter{ResponseWriter: w, last: time.Now(), flush: func(n int64, done bool) {
		if err := a.svc.DownloadProgress(ctx, actionID, art.ID, n, done); err != nil {
			a.log.Warn("download progress", "target", t.ControllerID, "err", err)
		}
	}}
	http.ServeContent(pw, r, "", time.UnixMilli(art.CreatedAt), f)
	pw.flush(pw.n-pw.flushed, !ranged && pw.n == art.Size)
}

// progressWriter counts the bytes written through it and reports them, at
// most every two seconds.
type progressWriter struct {
	http.ResponseWriter
	n, flushed int64
	last       time.Time
	flush      func(n int64, done bool)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	k, err := p.ResponseWriter.Write(b)
	p.n += int64(k)
	if time.Since(p.last) >= 2*time.Second {
		p.flush(p.n-p.flushed, false)
		p.flushed = p.n
		p.last = time.Now()
	}
	return k, err
}
