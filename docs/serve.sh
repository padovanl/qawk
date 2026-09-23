#!/usr/bin/env bash

# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Luca Padovan

# The documentation site, on this machine.
#
#   docs/serve.sh              http://localhost:8099, and opens a browser
#   docs/serve.sh 9000         another port
#   docs/serve.sh --no-open    no browser
#
# GitHub Pages serves docs/ as static files and nothing else -- no Jekyll, no
# build step -- so this serves exactly what GitHub would. Nothing is uploaded
# and the repository does not have to be public to look at it.
set -euo pipefail

cd "$(dirname "$0")"

port=8099
open=1
for a in "$@"; do
  case "$a" in
    --no-open) open=0 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *[!0-9]*)  echo "not a port: $a" >&2; exit 2 ;;
    *)         port=$a ;;
  esac
done

command -v python3 >/dev/null || { echo "python3 is needed" >&2; exit 1; }

# A port already taken is the same script in another terminal more often than
# not, so say which, rather than failing with an address in use.
if python3 -c "import socket,sys; s=socket.socket(); sys.exit(0 if s.connect_ex(('127.0.0.1',$port))==0 else 1)"; then
  echo "port $port is already serving something -- http://localhost:$port" >&2
  echo "try: docs/serve.sh $((port + 1))" >&2
  exit 1
fi

echo "Qawk documentation -> http://localhost:$port"
echo "Ctrl-C to stop."
[ "$open" = 1 ] && (sleep 1; (xdg-open "http://localhost:$port" || open "http://localhost:$port") >/dev/null 2>&1 || true) &

# No caching: the point of running this is to look at a change, and a cached
# stylesheet is the change not appearing.
exec python3 -c '
import sys, functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

class H(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".svg": "image/svg+xml", ".woff2": "font/woff2",
                      ".js": "text/javascript", ".mjs": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        # the 200s are noise; a 404 is a link that is wrong
        if not str(args[1] if len(args) > 1 else "").startswith("2"):
            sys.stderr.write("  %s\n" % (fmt % args))

ThreadingHTTPServer.allow_reuse_address = True
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
' "$port"
