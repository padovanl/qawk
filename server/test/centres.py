#!/usr/bin/env python3

# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Luca Padovan

"""Centres and their channels, and systems deployed by channel -- end to end.

    python3 server/test/centres.py [http://localhost:18080]

Needs a Qawk it may fill with test data, and Docker, to run qawk-sim from the
Qawk image ($QAWK_IMAGE, qawk:next by default). Eight systems -- a 6hd with
two st05 and a hyper each -- in four centres.

  * the centres are found from what the devices report (attribute.centerid);
  * a centre is put in a channel and every device of it follows; a centre
    moved to another channel moves them all;
  * one device of a centre cannot be moved by hand into another channel (its
    centre would take it back), but it can be lent to a temporary channel,
    where it stays until sent home;
  * a channel's release leaves the devices of a system alone: system
    deployments update them;
  * a system deployment takes the systems of one channel, of some centres.
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18080").rstrip("/")
ADMIN = ("admin", os.environ.get("QAWK_PASSWORD", "changeme"))
IMAGE = os.environ.get("QAWK_IMAGE", "qawk:next")
R = uuid.uuid4().hex[:4]
KEY = "sys" + R                     # the attribute naming each device's system
# QAWK_GATEWAY_TOKEN: the server's own token -- on a server real devices use,
# the test writes back the key that is already there and locks nobody out
SIM, TOKEN, C = f"qawk-sim-centres-{R}", os.environ.get("QAWK_GATEWAY_TOKEN") or "centres-" + R, f"t{R}c"
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
        h["Content-Type"], data = ctype, raw.encode() if isinstance(raw, str) else raw
    try:
        r = urllib.request.urlopen(urllib.request.Request(BASE + path, data=data, method=method, headers=h), timeout=60)
        st, b = r.status, r.read()
    except urllib.error.HTTPError as e:
        st, b = e.code, e.read()
    try:
        return st, json.loads(b) if b else None
    except ValueError:
        return st, b.decode(errors="replace")


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


def centres():
    return {c["centre"]: c for c in must("GET", "/qawk/v1/centres")["content"] if c["centre"].startswith(C)}


def members(fid):
    return must("GET", f"/qawk/v1/fleets/{fid}")["members"]


def fleet_of(cid):
    st, t = call("GET", f"/qawk/v1/targets/state?ids={cid}")
    s = (t or {}).get(cid) or next((x for x in (t or {}).get("content", []) if x.get("controllerId") == cid), {})
    return (s.get("fleet") or {}).get("name")


def main():
    print(f"  server {BASE}, run {R}\n")
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.enabled", {"value": True})
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.key", {"value": TOKEN})
    must("PUT", "/qawk/v1/centres/settings", {"field": "attribute.centerid"})
    fa = must("POST", "/qawk/v1/fleets", {"name": f"beta-{R}", "colour": "#e5a50a"})["id"]
    fb = must("POST", "/qawk/v1/fleets", {"name": f"prod-{R}", "colour": "#1c71d8"})["id"]
    ft = must("POST", "/qawk/v1/fleets", {"name": f"expo-{R}", "temporary": True})["id"]
    subprocess.run(["docker", "run", "-d", "--rm", "--name", SIM, "--network", "host", "--entrypoint", "qawk-sim", IMAGE,
                    "-url", BASE, "-token", TOKEN, "-prefix", "x" + R, "-interval", "3s",
                    "-install-min", "2s", "-install-max", "4s", "-centre-prefix", C,
                    "-system", f"{KEY}:8:6hd=1,st05=2,hyper=1:centers=4"], check=True, capture_output=True)
    try:
        cs = until(lambda: (lambda m: len(m) == 4 and all(c["devices"] == 8 for c in m.values()) and m)(centres()), 120)
        check("four centres found from what the devices report, eight devices each", bool(cs),
              str({k: v["devices"] for k, v in (cs or {}).items()}))

        must("PUT", "/qawk/v1/centres", {"centres": [C + "01", C + "02"], "fleetId": fa})
        must("PUT", "/qawk/v1/centres", {"centres": [C + "03", C + "04"], "fleetId": fb})
        got = until(lambda: members(fa) == 16 and members(fb) == 16, 60)
        check("two centres in beta, two in prod: every device follows its centre", bool(got),
              f"beta {members(fa)}, prod {members(fb)}")
        cs = centres()
        check("each centre says all its devices are in its channel",
              all(c["onChannel"] == c["devices"] == 8 for c in cs.values()),
              str({k: (v["fleet"], v["onChannel"]) for k, v in cs.items()}))

        must("PUT", "/qawk/v1/centres", {"centres": [C + "02"], "fleetId": fb})
        got = until(lambda: members(fa) == 8 and members(fb) == 24, 60)
        check("a centre moved to prod takes all eight of its devices with it", bool(got),
              f"beta {members(fa)}, prod {members(fb)}")

        one = f"x{R}-{KEY}-05-st05-1"             # system 05 is in the third centre, in prod
        st, j = call("PUT", f"/qawk/v1/fleets/{fa}/targets", [one])
        check("one device of a centre cannot be moved by hand into another channel", st == 400,
              f"{st} {(j or {}).get('message', '')}")
        st, _ = call("PUT", f"/qawk/v1/fleets/{ft}/targets", [one])
        check("but it can be lent to a temporary channel", st in (200, 204), st)
        time.sleep(10)
        check("where it stays: its centre does not take it back", members(ft) == 1, f"expo {members(ft)}")
        must("POST", f"/qawk/v1/fleets/{ft}/return", {"controllerIds": [one]})
        got = until(lambda: members(ft) == 0 and members(fb) == 24, 30)
        check("sent home, it is in prod again", bool(got), f"expo {members(ft)}, prod {members(fb)}")

        # a system type: the devices of a system are left to system deployments
        topo = f"""api_version: mender/v1
kind: topology
system_type: sixhd-{R}
qawk_system_key: attribute.{KEY}
components:
  - component_type: 6hd
  - component_type: st05
  - component_type: hyper
"""
        tid = must("POST", "/qawk/v1/systemtypes/import", raw=topo, ctype="application/yaml")["id"]
        sy = must("GET", f"/qawk/v1/systemtypes/{tid}/systems")["content"]
        check("each system knows its centre and its channel",
              len(sy) == 8 and all(s["group"].startswith(C) and s["fleet"] in (f"beta-{R}", f"prod-{R}") for s in sy),
              str([(s["system"], s["group"], s["fleet"]) for s in sy][:3]))
        solo = make_set(f"solo-{R}", "1.0")
        must("PUT", f"/qawk/v1/fleets/{fa}", {"distributionSetId": solo})
        time.sleep(12)
        f = must("GET", f"/qawk/v1/fleets/{fa}")
        q = urllib.parse.quote(f"assignedds.name==solo-{R}")
        sent = must("GET", f"/rest/v1/targets?limit=1&q={q}")["total"]
        check("beta's release is not sent to the devices of a system", sent == 0 and f["inSystems"] == 8,
              f"{sent} assigned, {f['inSystems']} in systems, release members {(f.get('progress') or {}).get('members')}")

        sets = {c: make_set(f"{c}-{R}", "2.0") for c in ("6hd", "st05", "hyper")}
        man = must("POST", "/qawk/v1/manifests", {"name": f"sixhd-{R}-2.0", "systemTypeId": tid, "components": [
            {"componentType": "st05", "distributionSetId": sets["st05"], "order": 10},
            {"componentType": "hyper", "distributionSetId": sets["hyper"], "order": 10},
            {"componentType": "6hd", "distributionSetId": sets["6hd"], "order": 20}]})
        d = must("POST", "/qawk/v1/systemdeployments", {"name": f"prod-{R}-all", "manifestId": man["id"],
                                                        "fleetId": fb, "maxParallel": 1, "maxFailed": 0})
        d = must("POST", f"/qawk/v1/systemdeployments/{d['id']}/start")
        check("a deployment over prod takes prod's systems: three centres, six systems", d["total"] == 6,
              f"{d['total']} systems, channel {d.get('fleet')}")
        must("POST", f"/qawk/v1/systemdeployments/{d['id']}/abort")
        d = must("POST", "/qawk/v1/systemdeployments", {"name": f"prod-{R}-one", "manifestId": man["id"],
                                                        "fleetId": fb, "groups": [C + "03"], "maxParallel": 2})
        d = must("POST", f"/qawk/v1/systemdeployments/{d['id']}/start")
        keys = sorted(r["system"] for r in d["runs"])
        check("one centre of prod: its two systems", keys == [f"{KEY}-05", f"{KEY}-06"], str(keys))
        end = until(lambda: (lambda x: x["status"] in ("finished", "failed") and x)(
            must("GET", f"/qawk/v1/systemdeployments/{d['id']}")), 120, 3)
        check("and they are updated, in order", bool(end) and end["counts"]["succeeded"] == 2, end and end["reason"])
        st, j = call("POST", "/qawk/v1/systemdeployments", {"name": f"beta-{R}-none", "manifestId": man["id"],
                                                            "fleetId": fb, "groups": ["nowhere"]})
        st2, j2 = call("POST", f"/qawk/v1/systemdeployments/{(j or {}).get('id')}/start")
        check("a channel and centres with no system: refused, and said", st2 == 400, f"{st2} {(j2 or {}).get('message', '')}")
    finally:
        subprocess.run(["docker", "rm", "-f", SIM], capture_output=True)
    print(f"\n  {ok} ok, {bad} failed")
    sys.exit(1 if bad else 0)


main()
