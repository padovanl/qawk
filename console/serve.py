#!/usr/bin/env python3
"""
QubicaAMF - server for the hawkBit console.

    ./ota/hawkbit-ui/serve.py [--port 8090] [--hawkbit http://localhost:8080]

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
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))

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
        if self.path.startswith("/rest/"):
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    # --- routing ------------------------------------------------------------
    def do_GET(self):
        if self.path.startswith("/rest/"):
            return self.proxy("GET")
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
        if not self.path.startswith("/rest/"):
            self.send_error(404, "only /rest is proxied")
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
