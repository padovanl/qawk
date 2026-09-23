#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Luca Padovan

"""Every source file we wrote carries an SPDX header.

    python3 .github/check-headers.py

A licence statement in one file at the root is thin cover once a file has been
copied out of the repository, which is what happens to a file worth copying.
LICENSING.md tells contributors to add the header; this is what makes that
true rather than aspirational.

Vendored and recorded material is skipped: hawkBit's API descriptions and the
console's libraries are not ours to label.
"""
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", "node_modules", "vendor", "fonts", ".claude"}
SKIP_PARTS = ("console/js/vendor/", "server/reference/hawkbit-", "server/reference/samples/")
SUFFIXES = {".go", ".js", ".mjs", ".py", ".sh", ".css", ".yml", ".yaml"}

missing = []
checked = 0
for p in sorted(ROOT.rglob("*")):
    if not p.is_file() or p.suffix not in SUFFIXES:
        continue
    if any(d in p.parts for d in SKIP_DIRS):
        continue
    rel = p.relative_to(ROOT).as_posix()
    if any(rel.startswith(x) for x in SKIP_PARTS):
        continue
    checked += 1
    head = p.read_text(encoding="utf-8", errors="replace")[:400]
    if "SPDX-License-Identifier" not in head:
        missing.append(rel)

for m in missing:
    print(f"  no SPDX header: {m}", file=sys.stderr)
print(f"{checked} source files checked, {len(missing)} without a header")
sys.exit(1 if missing else 0)
