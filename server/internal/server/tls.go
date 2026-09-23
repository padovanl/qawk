// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan

package server

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"time"

	"qawk/internal/config"
)

// HTTPS, when QAWK_TLS_CERT and QAWK_TLS_KEY are given.
//
// A proxy in front of Qawk is still a perfectly good way to terminate TLS,
// and on Kubernetes it is usually the ingress's job. This is for everywhere
// else: a server in a centre, a single box, a lab -- anywhere putting nginx
// in front of one Go binary is a second thing to install, configure and keep
// patched for no gain.
//
// Devices send a bearer token on every poll. Over plain HTTP anyone on the
// path has the gateway token and the whole fleet with it, so this is the
// difference between an update server and a way to install software on
// somebody's machines.

// TLSConfig builds the server's TLS settings: the certificate, TLS 1.2 as the
// floor, and -- when an authority is given -- client certificates demanded
// and verified.
func TLSConfig(cfg config.Config) (*tls.Config, error) {
	cert, err := tls.LoadX509KeyPair(cfg.TLSCert, cfg.TLSKey)
	if err != nil {
		return nil, fmt.Errorf("reading the certificate and key: %w", err)
	}
	c := &tls.Config{
		Certificates: []tls.Certificate{cert},
		// 1.2 is the floor because devices in the field outlive fashions in
		// cryptography; Go picks 1.3 whenever the client can.
		MinVersion: tls.VersionTLS12,
		// Only for 1.2 -- 1.3's suites are not configurable, and are all fine.
		CipherSuites: []uint16{
			tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
			tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
			tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305,
			tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305,
		},
	}
	if cfg.TLSClientCA != "" {
		pem, err := os.ReadFile(cfg.TLSClientCA)
		if err != nil {
			return nil, fmt.Errorf("reading the client authority: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("%s holds no certificate this understands", cfg.TLSClientCA)
		}
		// Demanded and verified: a device with no certificate of this
		// authority never reaches a handler, let alone a token check.
		c.ClientCAs = pool
		c.ClientAuth = tls.RequireAndVerifyClientCert
	}
	return c, nil
}

// RedirectServer answers plain HTTP with a permanent redirect to the HTTPS
// address, so a device still pointed at the old URL is told where to go
// rather than failing. It redirects and nothing else: no API is served here.
func RedirectServer(cfg config.Config, log *slog.Logger) *http.Server {
	// QAWK_PUBLIC_URL, when it is set, is the address devices really use --
	// which is not this process's port when a container maps one to another,
	// or when a load balancer sits in front. Without it, the host the device
	// asked for plus the port this server listens on is the best guess there
	// is.
	base := cfg.PublicURL
	_, port, err := net.SplitHostPort(cfg.Listen)
	if err != nil {
		port = "443"
	}
	if base != "" {
		log.Info("plain HTTP redirects to the public URL", "url", base)
	}
	return &http.Server{
		Addr:              cfg.RedirectHTTP,
		ReadHeaderTimeout: 15 * time.Second,
		Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			target := base
			if target == "" {
				host := r.Host
				if h, _, err := net.SplitHostPort(host); err == nil {
					host = h
				}
				if port != "443" {
					host = net.JoinHostPort(host, port)
				}
				target = "https://" + host
			}
			// 308, not 301: it keeps the method and the body, so a device
			// POSTing its feedback does not have it turned into a GET and lost.
			http.Redirect(w, r, target+r.URL.RequestURI(), http.StatusPermanentRedirect)
		}),
	}
}
