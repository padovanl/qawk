// Qawk - QubicaAMF's update server, speaking hawkBit's protocols.
//
// See ota/qawk/README.md.
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
	go func() {
		<-ctx.Done()
		shut, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = httpSrv.Shutdown(shut)
	}()
	go srv.RunBackground(ctx)

	log.Info("qawk listening", "addr", cfg.Listen, "tenant", cfg.Tenant)
	if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("http", "err", err)
		os.Exit(1)
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
