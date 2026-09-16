#!/usr/bin/env python3
"""
QubicaAMF - server for the hawkBit console.

    console/serve.py [--port 8090] [--hawkbit http://localhost:8080]

It does two things, and the second one is the reason it exists at all:

  1. serves the static page next to this file;
  2. proxies /rest/... to hawkBit.

WHY A PROXY AND NOT A DIRECT CALL FROM THE BROWSER

The page is served from this port, hawkBit answers on another one. That is a
different ORIGIN, so the browser applies CORS: every request from the page to
hawkBit is either refused outright or preceded by a preflight that hawkBit does
not answer, and the console would show an empty table with no error worth
reading. hawkBit can be told to send CORS headers
(HAWKBIT_SERVER_SECURITY_CORS_ENABLED), but that means reconfiguring and
restarting the server -- and its database is in memory, so restarting it throws
away every target, module and set.

Proxying keeps page and API on ONE origin, and nothing about the hawkBit
container has to change.

CREDENTIALS ARE NOT KEPT HERE. The browser sends its own Authorization header
and this process passes it through unread. There is no session, no cookie and no
password on disk: closing the tab is logging out, and someone who reaches this
port still has to know hawkBit's password.

Standard library only, on purpose: this repository already depends on python3
everywhere, and a console for a bench tool should not bring a toolchain with it.
"""
import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

# A tab that was opened before the last rebuild keeps running the JavaScript it
# already has: no-store stops the cache, it does not reload a live page. So the
# server states which build it is serving and the console watches for a change.
def build_stamp():
    hsh = hashlib.sha256()
    names = ["index.html", "style.css", "fonts.css"]
    for root, _, files in os.walk(os.path.join(HERE, "js")):
        names += [os.path.relpath(os.path.join(root, f), HERE)
                  for f in files if f.endswith(".js")]
    for name in sorted(names):
        try:
            with open(os.path.join(HERE, name), "rb") as fh:
                hsh.update(name.encode())
                hsh.update(fh.read())
        except OSError:
            pass
    return hsh.hexdigest()[:12]


BUILD = build_stamp()

# Hop-by-hop headers belong to one connection and must not be forwarded; passing
# Transfer-Encoding on in particular produces a body the browser cannot decode.
HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-length",
}


class Handler(SimpleHTTPRequestHandler):
    hawkbit = "http://localhost:8080"

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    # --- logging: one line per request, and nothing for static files ---------
    def log_message(self, fmt, *args):
        if self.proxied():
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    # --- routing ------------------------------------------------------------
    # /rest is the management API. /v3/api-docs is hawkBit's own description of
    # it, which the console reads once to check it is talking to the release it
    # was written for -- hawkBit publishes its version nowhere else a browser
    # can reach.
    PROXIED = ("/rest/", "/v3/api-docs", "/qawk/")

    def proxied(self):
        return self.path.startswith(self.PROXIED)

    def do_GET(self):
        if self.proxied():
            return self.proxy("GET")
        if self.path == "/_build":
            payload = json.dumps({"build": BUILD}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if self.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        return self.proxy("POST")

    def do_PUT(self):
        return self.proxy("PUT")

    def do_DELETE(self):
        return self.proxy("DELETE")

    # --- the proxy ----------------------------------------------------------
    def proxy(self, method):
        if not self.proxied():
            self.send_error(404, "only /rest and /v3/api-docs are proxied")
            return

        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None

        req = urllib.request.Request(
            self.hawkbit + self.path, data=body, method=method)
        # Pass the caller's own credentials and content type through untouched.
        for h in ("Authorization", "Content-Type", "Accept"):
            v = self.headers.get(h)
            if v:
                req.add_header(h, v)

        try:
            with urllib.request.urlopen(req, timeout=120) as up:
                self.relay(up.status, up.headers, up.read())
        except urllib.error.HTTPError as e:
            # hawkBit says a great deal in the body of a 4xx -- which field was
            # rejected, which entity already exists. Passing it through is what
            # lets the console show the server's own words instead of a code.
            self.relay(e.code, e.headers, e.read())
        except urllib.error.URLError as e:
            msg = json.dumps({
                "message": "cannot reach hawkBit at %s: %s" % (self.hawkbit, e.reason),
                "errorCode": "proxy.unreachable",
            }).encode()
            self.relay(502, {"Content-Type": "application/json"}, msg)

    def end_headers(self):
        # NO CACHING for the console's own files.
        #
        # The page is rebuilt and redeployed constantly while it is being worked
        # on, and without this the browser keeps serving what it already has:
        # the container is new, the file on disk is new, and the screen shows
        # the old one. Every "that change did not take effect" costs a hard
        # refresh to discover, and half of them get blamed on the code instead.
        # These files are a few kilobytes served over a LAN; there is nothing to
        # save by caching them.
        if not self.proxied():
            self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def relay(self, status, headers, body):
        self.send_response(status)
        for k, v in (headers.items() if hasattr(headers, "items") else headers.items()):
            if k.lower() not in HOP:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser(description="serve the QubicaAMF hawkBit console")
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--hawkbit", default=os.environ.get("HB_URL", "http://localhost:8080"),
                    help="hawkBit management API (default: http://localhost:8080)")
    args = ap.parse_args()

    Handler.hawkbit = args.hawkbit.rstrip("/")
    srv = ThreadingHTTPServer((args.bind, args.port), Handler)

    shown = args.bind if args.bind not in ("0.0.0.0", "::") else "localhost"
    print("QubicaAMF hawkBit console")
    print("  console : http://%s:%d" % (shown, args.port))
    print("  hawkBit : %s" % Handler.hawkbit)
    print("  log in with the hawkBit user; nothing is stored on this side.")
    print("  Ctrl-C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped.")


if __name__ == "__main__":
    main()
