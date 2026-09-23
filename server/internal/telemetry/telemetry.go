// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

// Package telemetry sends Qawk's metrics and traces to an OpenTelemetry
// collector over OTLP/HTTP (a Qawk addition).
//
// It is configured the way every OpenTelemetry SDK is, by the standard
// environment variables, and is off unless one of them asks for it:
//
//	OTEL_EXPORTER_OTLP_ENDPOINT          http://otel-collector:4318 (both signals)
//	OTEL_EXPORTER_OTLP_METRICS_ENDPOINT  / ..._TRACES_ENDPOINT, one signal
//	OTEL_EXPORTER_OTLP_HEADERS           authorization=Bearer ...
//	OTEL_METRICS_EXPORTER=otlp|none      OTEL_TRACES_EXPORTER=otlp|none
//	OTEL_METRIC_EXPORT_INTERVAL          milliseconds, 60000 by default
//	OTEL_TRACES_SAMPLER / _ARG           parentbased_traceidratio / 0.01
//	OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES, OTEL_SDK_DISABLED
//
// Metrics: http.server.request.duration (a histogram, with the method, the
// status code and qawk.surface -- ddi, mgmt, qawk) and the gauges /metrics
// shows (targets by status, fleets, releases, the leader, the database pool)
// under OpenTelemetry names: qawk.targets, qawk.fleet.on_release, ...
//
// Traces: a span per request, named after its route (GET
// /{tenant}/controller/v1/{controllerId}). With ten thousand devices polling
// that is a lot of spans: sample them (OTEL_TRACES_SAMPLER).
package telemetry

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"time"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/metric/noop"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"qawk/internal/metrics"
)

// The gauges of package metrics, by their OpenTelemetry names.
var names = map[string]string{
	"qawk_targets":                "qawk.targets",
	"qawk_actions_active":         "qawk.actions.active",
	"qawk_rollouts_running":       "qawk.rollouts.running",
	"qawk_fleet_releases_pending": "qawk.fleet.releases.pending",
	"qawk_fleet_releases_halted":  "qawk.fleet.releases.halted",
	"qawk_fleet_devices":          "qawk.fleet.devices",
	"qawk_fleet_on_release":       "qawk.fleet.on_release",
	"qawk_fleet_updating":         "qawk.fleet.updating",
	"qawk_fleet_failed":           "qawk.fleet.failed",
	"qawk_db_connections":         "qawk.db.connections",
	"qawk_leader":                 "qawk.leader",
	"qawk_uptime_seconds":         "qawk.uptime",
	"qawk_goroutines":             "qawk.goroutines",
	"qawk_heap_bytes":             "qawk.heap",
}

// Telemetry is what was switched on, and how to flush it at the end.
type Telemetry struct {
	Metrics, Traces bool
	shutdown        []func(context.Context) error
}

// Wrap puts a span around every request, when traces are on.
func (t *Telemetry) Wrap(h http.Handler) http.Handler {
	if !t.Traces {
		return h
	}
	return otelhttp.NewHandler(h, "qawk",
		// the request histogram is ours, with qawk.surface: not a second one
		otelhttp.WithMeterProvider(noop.NewMeterProvider()),
		otelhttp.WithFilter(func(r *http.Request) bool {
			return r.URL.Path != "/health" && r.URL.Path != "/live" && r.URL.Path != "/metrics"
		}),
		otelhttp.WithSpanNameFormatter(func(_ string, r *http.Request) string {
			return r.Method + " " + metrics.Surface(r.URL.Path)
		}))
}

// Shutdown sends what is still buffered.
func (t *Telemetry) Shutdown(ctx context.Context) error {
	var errs []error
	for _, f := range t.shutdown {
		errs = append(errs, f(ctx))
	}
	return errors.Join(errs...)
}

func enabled(signal string) bool {
	if strings.EqualFold(os.Getenv("OTEL_SDK_DISABLED"), "true") {
		return false
	}
	if v := os.Getenv("OTEL_" + signal + "_EXPORTER"); v != "" {
		return strings.EqualFold(v, "otlp")
	}
	return os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT") != "" || os.Getenv("OTEL_EXPORTER_OTLP_"+signal+"_ENDPOINT") != ""
}

// Setup switches on what the environment asks for.
func Setup(ctx context.Context, version string, m *metrics.Metrics, log *slog.Logger) (*Telemetry, error) {
	t := &Telemetry{Metrics: enabled("METRICS"), Traces: enabled("TRACES")}
	if !t.Metrics && !t.Traces {
		return t, nil
	}
	host, _ := os.Hostname()
	// ours first, then the environment's, which wins
	res, err := resource.New(ctx,
		resource.WithAttributes(attribute.String("service.name", "qawk"), attribute.String("service.version", version),
			attribute.String("service.instance.id", host)),
		resource.WithFromEnv(), resource.WithTelemetrySDK())
	if err != nil {
		return nil, err
	}

	if t.Metrics {
		exp, err := otlpmetrichttp.New(ctx)
		if err != nil {
			return nil, err
		}
		mp := sdkmetric.NewMeterProvider(sdkmetric.WithResource(res), sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exp)))
		otel.SetMeterProvider(mp)
		t.shutdown = append(t.shutdown, mp.Shutdown)
		if err := instruments(mp.Meter("qawk"), m); err != nil {
			return nil, err
		}
	}
	if t.Traces {
		exp, err := otlptracehttp.New(ctx)
		if err != nil {
			return nil, err
		}
		tp := sdktrace.NewTracerProvider(sdktrace.WithResource(res), sdktrace.WithBatcher(exp))
		otel.SetTracerProvider(tp)
		otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(propagation.TraceContext{}, propagation.Baggage{}))
		t.shutdown = append(t.shutdown, tp.Shutdown)
	}
	log.Info("OpenTelemetry", "metrics", t.Metrics, "traces", t.Traces,
		"endpoint", os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT"))
	return t, nil
}

func instruments(meter metric.Meter, m *metrics.Metrics) error {
	hist, err := meter.Float64Histogram("http.server.request.duration", metric.WithUnit("s"),
		metric.WithDescription("Duration of HTTP server requests."),
		metric.WithExplicitBucketBoundaries(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10))
	if err != nil {
		return err
	}
	m.OnObserve(func(surface, method string, code int, d time.Duration) {
		hist.Record(context.Background(), d.Seconds(), metric.WithAttributes(
			attribute.String("http.request.method", method), attribute.Int("http.response.status_code", code),
			attribute.String("qawk.surface", surface)))
	})

	gauges := map[string]metric.Float64ObservableGauge{}
	var obs []metric.Observable
	for prom, name := range names {
		g, err := meter.Float64ObservableGauge(name)
		if err != nil {
			return err
		}
		gauges[prom] = g
		obs = append(obs, g)
	}
	_, err = meter.RegisterCallback(func(ctx context.Context, o metric.Observer) error {
		ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		gs, err := m.Gather(ctx)
		for _, g := range gs {
			inst, ok := gauges[g.Name]
			if !ok {
				continue
			}
			attrs := make([]attribute.KeyValue, 0, len(g.Labels))
			for k, v := range g.Labels {
				attrs = append(attrs, attribute.String("qawk."+k, v))
			}
			o.ObserveFloat64(inst, g.Value, metric.WithAttributes(attrs...))
		}
		return err
	}, obs...)
	return err
}
