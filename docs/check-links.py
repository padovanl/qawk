#!/usr/bin/env python3
"""Every internal link and anchor in the documentation site resolves.

    python3 docs/check-links.py

A link to a page that is not there, or to an anchor that does not exist on the
page it points at, is the commonest way documentation rots. This is cheap
enough to run on every push."""
import os
import re
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
ids_cache = {}


def ids_of(path):
    if path not in ids_cache:
        try:
            s = open(path, encoding="utf-8").read()
        except OSError:
            s = ""
        ids_cache[path] = set(re.findall(r'id="([^"]+)"', s))
    return ids_cache[path]


pages, bad = [], []
for dirpath, _, filenames in os.walk(ROOT):
    if os.sep + "assets" in dirpath:
        continue
    pages += [os.path.join(dirpath, f) for f in filenames if f.endswith(".html")]

for page in pages:
    src = open(page, encoding="utf-8").read()
    base = os.path.dirname(page)
    for href in re.findall(r'(?:href|src)="([^"]+)"', src):
        if href.startswith(("http://", "https://", "mailto:", "data:")):
            continue
        if href.startswith("#"):
            # "#/..." is the API reference's own hash router, not an anchor
            if href[1:] and not href.startswith("#/") and href[1:] not in ids_of(page):
                bad.append((page, href, "no such id on this page"))
            continue
        path, _, frag = href.partition("#")
        if not path:
            continue
        target = os.path.normpath(os.path.join(base, urllib.parse.unquote(path)))
        if os.path.isdir(target):
            target = os.path.join(target, "index.html")
        if not os.path.exists(target):
            bad.append((page, href, "missing file"))
        elif frag and not frag.startswith("/") and target.endswith(".html"):
            # the API reference draws its own content, so its anchors are not
            # in the file on disk -- its links are checked by docs/check.mjs
            if "api" + os.sep + "index.html" in target:
                continue
            if frag not in ids_of(target):
                bad.append((page, href, "no such anchor in the target"))

for page, href, why in bad:
    print(f"  BROKEN {os.path.relpath(page, ROOT)} -> {href}: {why}", file=sys.stderr)
print(f"{len(pages)} pages, {len(bad)} broken links")
sys.exit(1 if bad else 0)
