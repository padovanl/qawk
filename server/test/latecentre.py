#!/usr/bin/env python3
"""A channel's orchestrator follows the channel -- end to end.

    python3 server/test/latecentre.py [http://localhost:18080]

Needs a Qawk it may fill with test data, and Docker, to run qawk-sim from the
Qawk image ($QAWK_IMAGE, qawk:next by default). Eight systems in four centres.

A release's SET keeps reaching new members for as long as it is the channel's
release. Its MANIFEST did not: the systems were chosen once, when the release
started. So a centre moved into prod afterwards got nothing at all -- its
standalone devices took prod's set, and its systems were left out of the
orchestrator and, being system members, out of the channel's delivery too.

  * a centre moved into the channel AFTER the release finished is taken: the
    deployment reopens, the release reopens, and its systems are updated;
  * the centres are taken in the order the channel names, not alphabetically;
  * a centre moved OUT before the orchestrator reaches it is given up, not
    updated with a channel's manifest it no longer belongs to.
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
KEY = "sys" + R
SIM, C = f"qawk-sim-late-{R}", f"l{R}c"
TOKEN = os.environ.get("QAWK_GATEWAY_TOKEN") or "late-" + R
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


def until(fn, timeout=180, step=2):
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
    st, _ = call("POST", f"/rest/v1/softwaremodules/{sm['id']}/artifacts", raw=body,
                 ctype="multipart/form-data; boundary=" + bd)
    assert st == 201, st
    return must("POST", "/rest/v1/distributionsets",
                [{"name": module, "version": version, "type": "app", "modules": [{"id": sm["id"]}]}])[0]["id"]


fleet = lambda fid: must("GET", f"/qawk/v1/fleets/{fid}")
sd = lambda i: must("GET", f"/qawk/v1/systemdeployments/{i}")
ended = lambda i: (lambda d: d["status"] in ("finished", "failed", "aborted") and d)(sd(i))


def centres():
    return {c["centre"]: c for c in must("GET", "/qawk/v1/centres")["content"] if c["centre"].startswith(C)}


def runs_of(d, status=None):
    return [r for r in d["runs"] if status is None or r["status"] == status]


def main():
    print(f"  server {BASE}, run {R}\n")
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.enabled", {"value": True})
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.key", {"value": TOKEN})
    must("PUT", "/qawk/v1/centres/settings", {"field": "attribute.centerid"})

    # one system at a time, one centre at a time: the order is then observable
    prod = must("POST", "/qawk/v1/fleets", {"name": f"late-prod-{R}", "colour": "#1c71d8",
                                            "orchestrator": {"maxParallel": 1, "maxFailed": 0, "byCentre": True}})["id"]

    subprocess.run(["docker", "run", "-d", "--rm", "--name", SIM, "--network", "host", "--entrypoint", "qawk-sim",
                    IMAGE, "-url", BASE, "-token", TOKEN, "-prefix", "l" + R, "-interval", "3s",
                    "-install-min", "2s", "-install-max", "4s", "-centre-prefix", C,
                    "-system", f"{KEY}:8:6hd=1,st05=1:centers=4"], check=True, capture_output=True)
    try:
        cs = until(lambda: (lambda m: len(m) == 4 and all(c["devices"] == 4 for c in m.values()) and m)(centres()), 150)
        check("four centres, two systems each", bool(cs), str({k: v["devices"] for k, v in (cs or {}).items()}))

        topo = f"""api_version: mender/v1
kind: topology
system_type: late-{R}
qawk_system_key: attribute.{KEY}
components:
  - component_type: 6hd
  - component_type: st05
"""
        tid = must("POST", "/qawk/v1/systemtypes/import", raw=topo, ctype="application/yaml")["id"]
        until(lambda: len(must("GET", f"/qawk/v1/systemtypes/{tid}/systems")["content"]) == 8, 60)

        sets = {c: make_set(f"{c}-{R}", "2.0") for c in ("6hd", "st05")}
        man = must("POST", "/qawk/v1/manifests", {"name": f"late-{R}-2.0", "systemTypeId": tid, "components": [
            {"componentType": "st05", "distributionSetId": sets["st05"], "order": 10},
            {"componentType": "6hd", "distributionSetId": sets["6hd"], "order": 20}]})
        solo = make_set(f"solo-{R}", "2.0")

        # ---------------------------------------------- a centre that arrives late
        must("PUT", "/qawk/v1/centres", {"centres": [C + "01"], "fleetId": prod})
        until(lambda: fleet(prod)["members"] == 4, 60)

        must("PUT", f"/qawk/v1/fleets/{prod}", {"distributionSetId": solo, "manifestId": man["id"]})
        rel = fleet(prod)["release"]
        dep = rel["systemDeploymentId"]
        check("the release starts the orchestrator on c01's two systems only",
              sd(dep)["total"] == 2, f"{sd(dep)['total']} systems")

        d = until(lambda: ended(dep), 300, 3) or sd(dep)
        check("c01's systems are updated, and the deployment finishes",
              d["status"] == "finished" and d["counts"]["succeeded"] == 2, d["reason"])
        done = until(lambda: (fleet(prod)["release"] or {}).get("status") == "completed", 120)
        check("and the release completes", bool(done))

        # the centre nobody thought about when the release went out
        must("PUT", "/qawk/v1/centres", {"centres": [C + "02"], "fleetId": prod})

        grown = until(lambda: (lambda x: x["total"] == 4 and x)(sd(dep)), 150, 3) or sd(dep)
        check("a centre moved in afterwards is taken by the same deployment",
              grown["total"] == 4, f"{grown['total']} systems, status {grown['status']}")
        check("which is running again, saying why",
              grown["status"] == "running" or grown["counts"]["succeeded"] == 4, grown["reason"])
        reopened = until(lambda: (fleet(prod)["release"] or {}).get("status") == "active", 90)
        check("and the release is under way again", bool(reopened),
              (fleet(prod)["release"] or {}).get("status"))

        d = until(lambda: ended(dep), 300, 3) or sd(dep)
        check("c02's systems are updated too, by the release nobody re-ran",
              d["status"] == "finished" and d["counts"]["succeeded"] == 4, d["reason"])
        check("and the release completes again",
              bool(until(lambda: (fleet(prod)["release"] or {}).get("status") == "completed", 120)))

        # ------------------------------------------------ the order of the centres
        # c04 before c03, which is not the order their names are in
        must("PUT", f"/qawk/v1/fleets/{prod}",
             {"orchestrator": {"maxParallel": 1, "maxFailed": 0, "byCentre": True,
                               "centres": [C + "04", C + "03"]}})
        must("PUT", "/qawk/v1/centres", {"centres": [C + "03", C + "04"], "fleetId": prod})
        until(lambda: fleet(prod)["members"] == 16, 90)

        man2 = must("POST", "/qawk/v1/manifests", {"name": f"late-{R}-3.0", "systemTypeId": tid, "components": [
            {"componentType": "st05", "distributionSetId": make_set(f"st05b-{R}", "3.0"), "order": 10},
            {"componentType": "6hd", "distributionSetId": make_set(f"6hdb-{R}", "3.0"), "order": 20}]})
        must("PUT", f"/qawk/v1/fleets/{prod}", {"distributionSetId": solo, "manifestId": man2["id"]})
        dep2 = fleet(prod)["release"]["systemDeploymentId"]
        check("a deployment that names its centres takes only those",
              sd(dep2)["total"] == 4, f"{sd(dep2)['total']} systems of {C}03 and {C}04")

        # whoever starts first must be in c04: the channel said so
        first = until(lambda: (lambda rs: rs and rs[0])(
            [r for r in sorted(sd(dep2)["runs"], key=lambda r: r.get("startedAt") or 1 << 62)
             if r.get("startedAt")]), 180, 2)
        check("and takes them in the order it names, not by name",
              bool(first) and first["centre"] == C + "04",
              f"first started: {(first or {}).get('system')} in {(first or {}).get('centre')}")

        # ------------------------------------------------- a centre that walks out
        # c03 has not been reached yet -- one centre at a time, c04 first.
        # It is moved to ANOTHER channel, not out of this one: a centre with no
        # channel leaves its devices where they are (CentreStrays only moves
        # devices whose centre has a channel), so "fleetId": null would mean
        # "stop managing this centre", not "take its devices out".
        other = must("POST", "/qawk/v1/fleets", {"name": f"late-other-{R}"})["id"]
        must("PUT", "/qawk/v1/centres", {"centres": [C + "03"], "fleetId": other})
        gone = until(lambda: (lambda d: [r for r in d["runs"]
                                         if r["centre"] == C + "03" and r["status"] == "skipped"])(sd(dep2)), 180, 3)
        check("a centre moved out before the orchestrator reaches it is given up",
              bool(gone), (gone or [{}])[0].get("reason", "still pending"))

        d = until(lambda: ended(dep2), 300, 3) or sd(dep2)
        check("and the deployment ends with the systems that stayed",
              d["status"] == "finished" and d["counts"]["succeeded"] == 2
              and d["counts"]["skipped"] == 2, d["reason"])

    finally:
        subprocess.run(["docker", "rm", "-f", SIM], capture_output=True)

    print(f"\n  {ok} ok, {bad} failed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
