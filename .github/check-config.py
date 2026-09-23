#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Luca Padovan

"""Every setting the server reads is documented, and no document invents one.

    python3 .github/check-config.py

Configuration tables rot quietly: a variable is added, the table is not, and
the only way anyone finds out is by reading the source -- which is the thing
the table exists to save them from. Six had drifted before this existed.

Not everything named QAWK_* is the server's: the demo scripts and the contract
test have their own. Those are collected from where they are actually read, so
a document may mention them without being wrong, and a document may not invent
one that nobody reads at all.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent

# What the server itself reads, from the one place it reads them.
server = set(re.findall(r'env\("(QAWK_[A-Z_]+)"',
                        (ROOT / "server/internal/config/config.go").read_text()))

# What everything else reads: the demo, the tools, the tests.
elsewhere = set()
for rel in ("demo/start.sh", "demo/simulate.sh", "demo/compose.yml", "demo/seed.py",
            "server/test/contract.py", "server/test/orchestrated.py",
            "server/test/latecentre.py", "server/test/parity.py"):
    p = ROOT / rel
    if p.exists():
        elsewhere |= set(re.findall(r"QAWK_[A-Z_]+", p.read_text()))
elsewhere -= server

# These must carry every one of the server's settings: they are the reference.
COMPLETE = ["server/README.md", "docs/install/index.html"]
# These may carry a selection, but must not invent one.
PARTIAL = ["README.md", "docs/start/index.html"]

bad = 0
for rel in COMPLETE + PARTIAL:
    found = set(re.findall(r"QAWK_[A-Z_]+", (ROOT / rel).read_text()))
    if rel in COMPLETE:
        for name in sorted(server - found):
            print(f"  {rel}: does not document {name}", file=sys.stderr)
            bad += 1
    for name in sorted(found - server - elsewhere):
        print(f"  {rel}: documents {name}, which nothing reads", file=sys.stderr)
        bad += 1

print(f"{len(server)} server settings and {len(elsewhere)} belonging to the demo and the "
      f"tests, checked against {len(COMPLETE) + len(PARTIAL)} documents, {bad} problems")
sys.exit(1 if bad else 0)
