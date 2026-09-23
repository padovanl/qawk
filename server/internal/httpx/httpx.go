// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

// Package httpx holds what every Qawk endpoint shares: JSON in and out, errors
// in hawkBit's exact shape, paging, and the links a response carries.
//
// hawkBit's clients -- our console, SWUpdate, the scripts -- read more than the
// status code. The console shows errorCode and message, and branches on some
// codes (an incomplete distribution set, an entity that already exists). So an
// error here is not "a 400": it is the same errorCode and exceptionClass
// hawkBit 1.1.0 sends for the same mistake. The recorded samples in
// reference/samples are the specification.
package httpx

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const ContentType = "application/hal+json"

// Error is an API error, serialised as hawkBit serialises its exceptions.
type Error struct {
	Status  int            `json:"-"`
	Code    string         `json:"errorCode"`
	Class   string         `json:"exceptionClass"`
	Message string         `json:"message,omitempty"`
	Info    map[string]any `json:"info,omitempty"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

const (
	pkgRepo = "org.eclipse.hawkbit.repository.exception."
	pkgRest = "org.eclipse.hawkbit.rest.exception."
)

// NotFound: "<Type> with given identifier {<id>} does not exist."
// qawkEntity is the set of things Qawk has and hawkBit has not. A 404 for one
// of them keeps hawkBit's error SHAPE -- so one parser still reads both
// surfaces -- but says qawk in the code and the class, because claiming
// org.eclipse.hawkbit.repository.exception.EntityNotFoundException for a
// Fleet names a class that never produced one and never could.
var qawkEntity = map[string]bool{
	"Fleet": true, "Release": true, "Centre": true, "SystemType": true,
	"Manifest": true, "SystemDeployment": true, "SystemRun": true,
	"User": true, "Role": true, "Token": true, "Command": true,
}

func NotFound(entity string, id any) *Error {
	code, class := "hawkbit.server.error.repo.entityNotFound", pkgRepo+"EntityNotFoundException"
	if qawkEntity[entity] {
		code, class = "qawk.error.repo.entityNotFound", "qawk.EntityNotFoundException"
	}
	return &Error{
		Status:  http.StatusNotFound,
		Code:    code,
		Class:   class,
		Message: fmt.Sprintf("%s with given identifier {%v} does not exist.", entity, id),
		Info:    map[string]any{"type": entity, "entityId": id},
	}
}

func AlreadyExists(msg string) *Error {
	return &Error{Status: http.StatusConflict, Code: "hawkbit.server.error.repo.entityAlreadyExists",
		Class: pkgRepo + "EntityAlreadyExistsException", Message: msg}
}

func NotReadable() *Error {
	return &Error{Status: http.StatusBadRequest, Code: "hawkbit.server.error.rest.body.notReadable",
		Class: pkgRest + "MessageNotReadableException", Message: "The given request body is not well formed"}
}

// Validation is a request that is well formed but not acceptable -- a
// missing name, a value out of range.
func Validation(msg string) *Error {
	return &Error{Status: http.StatusBadRequest, Code: "hawkbit.server.error.repo.constraintViolation",
		Class: "jakarta.validation.ConstraintViolationException", Message: msg}
}

func RSQLField(msg string) *Error {
	return &Error{Status: http.StatusBadRequest, Code: "hawkbit.server.error.rest.param.rsqlInvalidField",
		Class: pkgRepo + "RSQLParameterUnsupportedFieldException", Message: msg}
}

func RSQLSyntax(msg string) *Error {
	return &Error{Status: http.StatusBadRequest, Code: "hawkbit.server.error.rest.param.rsqlParamSyntax",
		Class: pkgRepo + "RSQLParameterSyntaxException", Message: msg}
}

func SortSyntax(msg string) *Error {
	return &Error{Status: http.StatusBadRequest, Code: "hawkbit.server.error.rest.param.sortParamSyntax",
		Class: pkgRest + "SortParameterSyntaxErrorException", Message: msg}
}

func SortField(msg string) *Error {
	return &Error{Status: http.StatusBadRequest, Code: "hawkbit.server.error.rest.param.sortParamInvalidField",
		Class: pkgRest + "SortParameterUnsupportedFieldException", Message: msg}
}

// Custom builds any other hawkBit error, for the few that need their own code
// (an incomplete set, a locked entity, an incompatible target type...).
func Custom(status int, code, class, msg string) *Error {
	return &Error{Status: status, Code: code, Class: class, Message: msg}
}

// WriteJSON writes v with hawkBit's content type.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", ContentType)
	w.WriteHeader(status)
	if v != nil {
		enc := json.NewEncoder(w)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(v)
	}
}

// WriteError writes err: an *Error as it is, anything else as a 500 that says
// as little as possible to the client and everything to the log.
func WriteError(w http.ResponseWriter, err error) {
	var e *Error
	if errors.As(err, &e) {
		WriteJSON(w, e.Status, e)
		return
	}
	WriteJSON(w, http.StatusInternalServerError, &Error{
		Code: "hawkbit.server.error.internal", Class: "java.lang.RuntimeException",
		Message: "internal error",
	})
}

// Decode reads a JSON body into v. Unknown fields are accepted, as Spring
// accepts them: a client written for a newer server must not break on ours.
func Decode(r *http.Request, v any) *Error {
	body, err := io.ReadAll(io.LimitReader(r.Body, 16<<20))
	if err != nil || len(strings.TrimSpace(string(body))) == 0 {
		return NotReadable()
	}
	if err := json.Unmarshal(body, v); err != nil {
		return NotReadable()
	}
	return nil
}

// Now is the time as the API speaks it.
func Now() int64 { return time.Now().UnixMilli() }

// -------------------------------------------------------------------- paging

type SortKey struct {
	Field string
	Desc  bool
}

type Page struct {
	Offset int
	Limit  int
	Sort   []SortKey
	Q      string
}

// ParsePage reads offset, limit, sort and q. The defaults are hawkBit's:
// offset 0, limit 50, and a limit above 500 is cut to 500.
func ParsePage(r *http.Request) (Page, *Error) {
	q := r.URL.Query()
	p := Page{Offset: 0, Limit: 50, Q: strings.TrimSpace(q.Get("q"))}
	if v := q.Get("offset"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			return p, Validation("offset must be a non-negative number")
		}
		p.Offset = n
	}
	if v := q.Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return p, Validation("limit must be a positive number")
		}
		p.Limit = min(n, 500)
	}
	if v := strings.TrimSpace(q.Get("sort")); v != "" {
		for _, part := range strings.Split(v, ",") {
			f, dir, ok := strings.Cut(strings.TrimSpace(part), ":")
			if !ok || f == "" {
				return p, SortSyntax("sort must be field:ASC or field:DESC, got " + part)
			}
			switch strings.ToUpper(dir) {
			case "ASC":
				p.Sort = append(p.Sort, SortKey{Field: strings.ToLower(f)})
			case "DESC":
				p.Sort = append(p.Sort, SortKey{Field: strings.ToLower(f), Desc: true})
			default:
				return p, SortSyntax("sort direction must be ASC or DESC, got " + dir)
			}
		}
	}
	return p, nil
}

// Paged is hawkBit's list envelope.
type Paged struct {
	Content any   `json:"content"`
	Total   int64 `json:"total"`
	Size    int   `json:"size"`
}

// ---------------------------------------------------------------------- links

// Base is the scheme and host every link in a response is built on: the
// configured public URL, or the request's own. A device follows the download
// links it is given, so they must name the address it reached us at.
func Base(r *http.Request, publicURL string) string {
	if publicURL != "" {
		return publicURL
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = p
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = h
	}
	return scheme + "://" + host
}

// Link is one HAL link.
type Link struct {
	Href string `json:"href"`
	Name string `json:"name,omitempty"`
}

func L(href string) Link { return Link{Href: href} }
