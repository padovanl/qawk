// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

// Package metrics is Qawk's /metrics, in Prometheus' text format (a Qawk
// addition), with no dependency: a handful of counters kept as requests go
// by, and gauges read from the database when Prometheus asks.
//
// What is kept:
//
//	qawk_http_requests_total{surface,method,code}   every request, by API
//	qawk_http_request_duration_seconds{surface}     a histogram of latency
//
// surface is ddi (the devices), mgmt (hawkBit's Management API), qawk
// (/qawk/v1), or other. The rest comes from a Source at scrape time.
package metrics

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Buckets of the latency histogram, in seconds.
var buckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

type histogram struct {
	counts []atomic.Int64 // one per bucket, not cumulative
	inf    atomic.Int64
	sum    atomic.Int64 // microseconds
	n      atomic.Int64
}

// Gauge is one line of a scrape: a name, labels, a value.
type Gauge struct {
	Name   string
	Help   string
	Labels map[string]string
	Value  float64
}

// Source gives the gauges read at scrape time (the database, the leader).
type Source func(ctx context.Context) ([]Gauge, error)

type Metrics struct {
	mu       sync.Mutex
	requests map[string]*atomic.Int64 // surface|method|code
	latency  map[string]*histogram    // surface
	sources  []Source
	hooks    []func(surface, method string, code int, d time.Duration)
	started  time.Time
}

func New() *Metrics {
	return &Metrics{requests: map[string]*atomic.Int64{}, latency: map[string]*histogram{}, started: time.Now()}
}

// AddSource registers gauges read at every scrape.
func (m *Metrics) AddSource(s Source) { m.sources = append(m.sources, s) }

// OnObserve also hands every request to f (package telemetry records it for
// OpenTelemetry). Hooks are added at startup, before requests come.
func (m *Metrics) OnObserve(f func(surface, method string, code int, d time.Duration)) {
	m.hooks = append(m.hooks, f)
}

// Gather reads every gauge: the process's, and the sources'. A failing source
// is left out, and its error returned with the rest.
func (m *Metrics) Gather(ctx context.Context) ([]Gauge, error) {
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	gauges := []Gauge{
		{Name: "qawk_uptime_seconds", Help: "Seconds since this instance started.", Value: time.Since(m.started).Seconds()},
		{Name: "qawk_goroutines", Help: "Goroutines of this instance.", Value: float64(runtime.NumGoroutine())},
		{Name: "qawk_heap_bytes", Help: "Heap in use by this instance.", Value: float64(ms.HeapInuse)},
	}
	var errs []error
	for _, src := range m.sources {
		g, err := src(ctx)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		gauges = append(gauges, g...)
	}
	return gauges, errors.Join(errs...)
}

// Surface names the API a path belongs to.
func Surface(path string) string {
	switch {
	case strings.HasPrefix(path, "/rest/"):
		return "mgmt"
	case strings.HasPrefix(path, "/qawk/"):
		return "qawk"
	case strings.Contains(path, "/controller/v1/"):
		return "ddi"
	}
	return "other"
}

// Observe counts one request.
func (m *Metrics) Observe(path, method string, code int, d time.Duration) {
	s := Surface(path)
	for _, f := range m.hooks {
		f(s, method, code, d)
	}
	key := s + "|" + method + "|" + fmt.Sprint(code)
	m.mu.Lock()
	c, ok := m.requests[key]
	if !ok {
		c = &atomic.Int64{}
		m.requests[key] = c
	}
	h, ok := m.latency[s]
	if !ok {
		h = &histogram{counts: make([]atomic.Int64, len(buckets))}
		m.latency[s] = h
	}
	m.mu.Unlock()
	c.Add(1)
	secs := d.Seconds()
	placed := false
	for i, b := range buckets {
		if secs <= b {
			h.counts[i].Add(1)
			placed = true
			break
		}
	}
	if !placed {
		h.inf.Add(1)
	}
	h.sum.Add(d.Microseconds())
	h.n.Add(1)
}

func labels(l map[string]string) string {
	if len(l) == 0 {
		return ""
	}
	keys := make([]string, 0, len(l))
	for k := range l {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		v := strings.NewReplacer(`\`, `\\`, `"`, `\"`, "\n", `\n`).Replace(l[k])
		parts = append(parts, fmt.Sprintf(`%s="%s"`, k, v))
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// Handler serves the scrape. With a token, only "Authorization: Bearer
// <token>" gets it.
func (m *Metrics) Handler(token string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if token != "" && r.Header.Get("Authorization") != "Bearer "+token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var b strings.Builder
		m.mu.Lock()
		keys := make([]string, 0, len(m.requests))
		for k := range m.requests {
			keys = append(keys, k)
		}
		surfaces := make([]string, 0, len(m.latency))
		for s := range m.latency {
			surfaces = append(surfaces, s)
		}
		m.mu.Unlock()
		sort.Strings(keys)
		sort.Strings(surfaces)

		b.WriteString("# HELP qawk_http_requests_total Requests served, by API surface, method and status code.\n")
		b.WriteString("# TYPE qawk_http_requests_total counter\n")
		for _, k := range keys {
			p := strings.SplitN(k, "|", 3)
			m.mu.Lock()
			v := m.requests[k].Load()
			m.mu.Unlock()
			fmt.Fprintf(&b, "qawk_http_requests_total%s %d\n", labels(map[string]string{"surface": p[0], "method": p[1], "code": p[2]}), v)
		}
		b.WriteString("# HELP qawk_http_request_duration_seconds Time to serve a request, by API surface.\n")
		b.WriteString("# TYPE qawk_http_request_duration_seconds histogram\n")
		for _, s := range surfaces {
			m.mu.Lock()
			h := m.latency[s]
			m.mu.Unlock()
			var cum int64
			for i, le := range buckets {
				cum += h.counts[i].Load()
				fmt.Fprintf(&b, "qawk_http_request_duration_seconds_bucket%s %d\n",
					labels(map[string]string{"surface": s, "le": fmt.Sprint(le)}), cum)
			}
			cum += h.inf.Load()
			fmt.Fprintf(&b, "qawk_http_request_duration_seconds_bucket%s %d\n", labels(map[string]string{"surface": s, "le": "+Inf"}), cum)
			fmt.Fprintf(&b, "qawk_http_request_duration_seconds_sum%s %g\n", labels(map[string]string{"surface": s}), float64(h.sum.Load())/1e6)
			fmt.Fprintf(&b, "qawk_http_request_duration_seconds_count%s %d\n", labels(map[string]string{"surface": s}), h.n.Load())
		}

		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		gauges, err := m.Gather(ctx)
		if err != nil {
			fmt.Fprintf(&b, "# a source failed: %s\n", strings.ReplaceAll(err.Error(), "\n", " "))
		}
		said := map[string]bool{}
		for _, g := range gauges {
			if !said[g.Name] {
				said[g.Name] = true
				fmt.Fprintf(&b, "# HELP %s %s\n# TYPE %s gauge\n", g.Name, g.Help, g.Name)
			}
			fmt.Fprintf(&b, "%s%s %g\n", g.Name, labels(g.Labels), g.Value)
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write([]byte(b.String()))
	})
}
