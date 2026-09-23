#!/usr/bin/env python3

# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Luca Padovan

"""Regenerate reference/PARITY.md from a running server.

    python3 server/test/parity.py [http://localhost:8080]

The old PARITY.md was a checklist kept by hand, and every box in it was empty
while the server implemented all 169 operations -- which is the failure mode of
every hand-kept checklist. This writes it from two sources that cannot drift:
hawkBit 1.1.0's own OpenAPI descriptions (reference/*.json) for what exists, and
the running server's /v3/api-docs -- built by walking its router -- for what is
really routed.

contract.py checks the two totals on every run, so a route that disappears
fails a test rather than quietly rotting this file.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080").rstrip("/")
ADMIN = ("admin", os.environ.get("QAWK_PASSWORD", "changeme"))
HERE = os.path.dirname(os.path.abspath(__file__))
REF = os.path.join(HERE, "..", "reference")
METHODS = ("get", "post", "put", "delete", "patch", "head")

GROUPS = [
    ("Direct Device Integration API", "hawkbit-1.1.0-Direct-Device-Integration-API.json",
     "Direct Device Integration API (devices)"),
    ("Management API", "hawkbit-1.1.0-Management-API.json",
     "Management API (the console, and scripts)"),
]

HEAD = """# hawkBit 1.1.0 parity — every operation

**Generated, not kept by hand.** Every line below was produced by comparing
hawkBit 1.1.0's own OpenAPI descriptions (the files beside this one) with what a
running Qawk declares at `/v3/api-docs`, which is built by walking its router.
`[x]` means the server really routes that operation.

Regenerate it with `python3 server/test/parity.py <server>`. The contract test
(`server/test/contract.py`) checks both totals on every run, so a route that
disappears fails the build rather than quietly rotting this file.

What "the same as hawkBit" means, and the five deliberate differences, are in
[../README.md](../README.md#hawkbit-parity) and on the
[documentation site](https://padovanl.github.io/qawk/hawkbit/).
"""


def get(path):
    req = urllib.request.Request(BASE + path, headers={
        "Authorization": "Basic " + base64.b64encode(f"{ADMIN[0]}:{ADMIN[1]}".encode()).decode()})
    return json.load(urllib.request.urlopen(req, timeout=30))


def ops(doc):
    return {(p, m) for p, o in doc.get("paths", {}).items() for m in o if m in METHODS}


def main():
    out, totals = [HEAD], []
    for name, ref, title in GROUPS:
        with open(os.path.join(REF, ref)) as f:
            full = json.load(f)
        try:
            declared = ops(get("/v3/api-docs/" + urllib.parse.quote(name)))
        except urllib.error.URLError as e:
            raise SystemExit(f"cannot reach {BASE}: {e}")

        everything = sorted(ops(full))
        by_tag = {}
        for path, method in everything:
            op = full["paths"][path][method]
            tag = (op.get("tags") or ["Other"])[0]
            by_tag.setdefault(tag, []).append(
                (method, path, (op.get("summary") or "").strip(), (path, method) in declared))

        done = sum(1 for k in everything if k in declared)
        totals.append((title, done, len(everything)))
        out.append(f"\n## {title}\n")
        out.append(f"**{done} of {len(everything)} operations.**\n")
        for tag in sorted(by_tag):
            out.append(f"\n### {tag}\n")
            for method, path, summary, ok in sorted(by_tag[tag], key=lambda r: (r[1], r[0])):
                line = f"- [{'x' if ok else ' '}] `{method.upper():<6} {path}`"
                if summary:
                    line += f" — {summary}"
                out.append(line)
        out.append("")

    with open(os.path.join(REF, "PARITY.md"), "w") as f:
        f.write("\n".join(out) + "\n")

    for title, done, total in totals:
        print(f"  {title}: {done} of {total}")
    print(f"  written to {os.path.normpath(os.path.join(REF, 'PARITY.md'))}")
    return 0 if all(d == t for _, d, t in totals) else 1


if __name__ == "__main__":
    sys.exit(main())
