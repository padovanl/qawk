#!/usr/bin/env python3

# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Luca Padovan

"""Promotion by hand (the default) and by itself -- end to end.

    python3 server/test/autopromote.py [http://localhost:18080]

Needs a Qawk it may fill with test data, and Docker, to run qawk-sim from the
Qawk image ($QAWK_IMAGE, qawk:next by default). Four fleets of three
simulated devices: src takes releases directly; under it, "manual" (the
default), "auto" (promotes itself when the gate opens) and "auto-approved"
(promotes itself, and waits for a person's approval).
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18080").rstrip("/")
ADMIN = ("admin", os.environ.get("QAWK_PASSWORD", "changeme"))
IMAGE = os.environ.get("QAWK_IMAGE", "qawk:next")
R = uuid.uuid4().hex[:4]
# QAWK_GATEWAY_TOKEN: the server's own token -- on a server real devices use,
# the test writes back the key that is already there and locks nobody out
SIM, TOKEN = f"qawk-sim-ap-{R}", os.environ.get("QAWK_GATEWAY_TOKEN") or "ap-" + R
ok = bad = 0


def check(name, cond, extra=""):
    global ok, bad
    ok, bad = (ok + 1, bad) if cond else (ok, bad + 1)
    print(f"  {'ok  ' if cond else 'FAIL'} {name}  {extra}".rstrip())
    return cond


def call(method, path, body=None, raw=None, ctype=None):
    h = {"Authorization": "Basic " + base64.b64encode(f"{ADMIN[0]}:{ADMIN[1]}".encode()).decode()}
    data = None
    if body is not None:
        h["Content-Type"], data = "application/json", json.dumps(body).encode()
    if raw is not None:
        h["Content-Type"], data = ctype, raw
    try:
        r = urllib.request.urlopen(urllib.request.Request(BASE + path, data=data, method=method, headers=h), timeout=60)
        st, b = r.status, r.read()
    except urllib.error.HTTPError as e:
        st, b = e.code, e.read()
    try:
        return st, json.loads(b) if b else None
    except ValueError:
        return st, None


def must(method, path, body=None, **kw):
    st, j = call(method, path, body, **kw)
    if st not in (200, 201, 202, 204):
        raise SystemExit(f"{method} {path} -> {st} {j}")
    return j


def until(fn, timeout=120, step=2):
    t0, last = time.time(), None
    while time.time() - t0 < timeout:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


def make_set(module, version):
    sm = must("POST", "/rest/v1/softwaremodules", [{"name": module, "version": version, "type": "application"}])[0]
    bd = "b" + uuid.uuid4().hex
    body = (f"--{bd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{module}.bin\"\r\n\r\n").encode() \
        + os.urandom(1024) + f"\r\n--{bd}--\r\n".encode()
    st, _ = call("POST", f"/rest/v1/softwaremodules/{sm['id']}/artifacts", raw=body, ctype="multipart/form-data; boundary=" + bd)
    assert st == 201, st
    return must("POST", "/rest/v1/distributionsets",
                [{"name": module, "version": version, "type": "app", "modules": [{"id": sm["id"]}]}])[0]["id"]


def fleet(fid):
    return must("GET", f"/qawk/v1/fleets/{fid}")


def main():
    print(f"  server {BASE}, run {R}\n")
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.enabled", {"value": True})
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.key", {"value": TOKEN})
    ring = lambda n: f"attribute.ring==ap{R}{n}"
    gate = {"minDevices": 3, "minSuccess": 100}
    src = must("POST", "/qawk/v1/fleets", {"name": f"src-{R}", "rule": ring("s")})["id"]
    man = must("POST", "/qawk/v1/fleets", {"name": f"manual-{R}", "rule": ring("m"), "upstreamId": src, "gate": gate})
    auto = must("POST", "/qawk/v1/fleets", {"name": f"auto-{R}", "rule": ring("a"), "upstreamId": src, "gate": gate,
                                            "autoPromote": True})["id"]
    appr = must("POST", "/qawk/v1/fleets", {"name": f"approved-{R}", "rule": ring("p"), "upstreamId": src,
                                            "gate": dict(gate, approvalRequired=True), "autoPromote": True})["id"]
    check("a fleet is promoted by hand unless told otherwise", man["autoPromote"] is False, str(man["autoPromote"]))
    man = man["id"]
    subprocess.run(["docker", "run", "-d", "--rm", "--name", SIM, "--network", "host", "--entrypoint", "qawk-sim", IMAGE,
                    "-url", BASE, "-token", TOKEN, "-prefix", "ap" + R, "-interval", "3s", "-install-min", "4s",
                    "-install-max", "8s"] + sum((["-fleet", f"ap{R}{n}:3"] for n in "smap"), []),
                   check=True, capture_output=True)
    try:
        got = until(lambda: all(fleet(f)["members"] == 3 for f in (src, man, auto, appr)), 90)
        check("four fleets of three devices", bool(got))
        ds = make_set(f"ap-{R}", "1.0")
        label = f"ap-{R}:1.0"
        must("PUT", f"/qawk/v1/fleets/{src}", {"distributionSetId": ds})
        time.sleep(3)
        check("while the gate is closed, nobody is promoted", fleet(auto)["distributionSet"] is None,
              str(fleet(auto)["distributionSet"]))
        until(lambda: (fleet(src).get("progress") or {}).get("onRelease") == 3, 120)
        a = until(lambda: (lambda f: f["distributionSet"] == label and f)(fleet(auto)), 60)
        check("the gate open, the automatic fleet promotes itself", bool(a),
              f"{(a or {}).get('distributionSet')} {((a or {}).get('release') or {}).get('reason')}")
        rel = (a or {}).get("release") or {}
        check("as 'system', and its history says so", rel.get("requestedBy") == "system" and "by itself" in (rel.get("reason") or ""),
              f"{rel.get('requestedBy')}: {rel.get('reason')}")
        on = until(lambda: (fleet(auto).get("progress") or {}).get("onRelease") == 3, 120)
        check("and its devices take the release", bool(on))
        p = until(lambda: (lambda f: f.get("pending") and f)(fleet(appr)), 30)
        check("the automatic fleet that asks for approval waits for a person",
              bool(p) and p["pending"]["status"] == "waiting_for_approval" and p["distributionSet"] is None,
              str((p or {}).get("pending")))
        if p:
            st, _ = call("POST", f"/qawk/v1/releases/{p['pending']['id']}/approve", {"note": "test"})
            check("a person approves it", st == 200, st)
            got = until(lambda: fleet(appr)["distributionSet"] == label, 30)
            check("and it goes out", bool(got))
        time.sleep(8)
        m = fleet(man)
        check("the fleet promoted by hand is still waiting for someone to promote it",
              m["distributionSet"] is None and not m.get("pending"), str(m["distributionSet"]))
        r = must("POST", f"/qawk/v1/fleets/{man}/promote", {"from": src})
        check("and someone does", r.get("distributionSet") == label and fleet(man)["distributionSet"] == label,
              str(r.get("distributionSet")))
        st, _ = call("PUT", f"/qawk/v1/fleets/{auto}", {"autoPromote": False})
        check("and the mode can be changed back to by hand", st == 200 and fleet(auto)["autoPromote"] is False)
    finally:
        subprocess.run(["docker", "rm", "-f", SIM], capture_output=True)
    print(f"\n  {ok} ok, {bad} failed")
    sys.exit(1 if bad else 0)


main()
