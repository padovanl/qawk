// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

// Qawk - QubicaAMF's update server, speaking hawkBit's protocols.
//
// See server/README.md.
package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	stdlog "log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"qawk/internal/config"
	"qawk/internal/db"
	"qawk/internal/server"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("configuration", "err", err)
		os.Exit(2)
	}
	level := slog.LevelInfo
	switch strings.ToLower(cfg.LogLevel) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	}
	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: level}))

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	pool, err := db.Open(ctx, cfg.DatabaseURL, cfg.DBMaxConns, cfg.DBWait, log)
	if err != nil {
		log.Error("database", "err", err)
		os.Exit(1)
	}
	defer pool.Close()
	if err := db.Migrate(ctx, pool, log); err != nil {
		log.Error("migrations", "err", err)
		os.Exit(1)
	}

	srv, err := server.New(ctx, cfg, pool, log)
	if err != nil {
		log.Error("startup", "err", err)
		os.Exit(1)
	}

	httpSrv := &http.Server{
		Addr:              cfg.Listen,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		// Go warns, on every request with a ";" in its query, that ";" is no
		// longer a separator. Qawk escapes them on purpose (FIQL's AND, see
		// server.keepSemicolons), so the warning is only noise.
		ErrorLog: stdlog.New(dropping{"URL query contains semicolon", os.Stderr}, "", 0),
	}
	var redirect *http.Server
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shut)
		if redirect != nil {
			_ = redirect.Shutdown(shut)
		}
	}()
	go srv.RunBackground(ctx)

	// HTTPS, when a certificate and key are given. Without them Qawk speaks
	// plain HTTP and a proxy in front of it terminates TLS -- which is still
	// the right shape when something else already owns the certificates.
	serve := httpSrv.ListenAndServe
	if cfg.TLS() {
		tlsCfg, err := server.TLSConfig(cfg)
		if err != nil {
			log.Error("tls", "err", err)
			os.Exit(1)
		}
		httpSrv.TLSConfig = tlsCfg
		serve = func() error { return httpSrv.ListenAndServeTLS("", "") }
		if cfg.RedirectHTTP != "" {
			redirect = server.RedirectServer(cfg, log)
			go func() {
				log.Info("redirecting plain HTTP to HTTPS", "addr", cfg.RedirectHTTP)
				if err := redirect.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
					log.Error("http redirect", "err", err)
				}
			}()
		}
	}

	log.Info("qawk listening", "addr", cfg.Listen, "tenant", cfg.Tenant,
		"tls", cfg.TLS(), "mutual-tls", cfg.TLSClientCA != "")
	if err := serve(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("http", "err", err)
		os.Exit(1)
	}
	flush, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(flush); err != nil {
		log.Warn("telemetry", "err", err)
	}
	log.Info("qawk stopped")
}

// dropping writes everything but the lines containing one phrase.
type dropping struct {
	phrase string
	w      io.Writer
}

func (d dropping) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte(d.phrase)) {
		return len(p), nil
	}
	return d.w.Write(p)
}
