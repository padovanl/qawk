#!/usr/bin/env python3
"""A channel's release through the orchestrator -- end to end.

    python3 server/test/orchestrated.py [http://localhost:18080]

Needs a Qawk it may fill with test data, and Docker, to run qawk-sim from the
Qawk image ($QAWK_IMAGE, qawk:next by default). Eight systems -- a 6hd with
two st05 and a hyper each -- and a neo-intel standing alone beside each, in
four centres: c01 and c02 in beta, c03 and c04 in prod.

  * beta is given a release with a set AND a manifest: the set goes to the
    neo-intel, the orchestrator takes beta's systems, one centre at a time;
  * the release is complete only once the systems are done, and prod's gate
    waits for them too;
  * promoted to prod, the manifest comes along: the orchestrator takes prod's
    systems, centre by centre -- 6hd-07's hyper fails 2.0, more than prod
    allows, and prod's release halts;
  * promoted without the orchestrator, a release leaves the systems alone;
  * a fleet that promotes itself takes the manifest along too.
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
KEY = "sys" + R                     # the attribute naming each device's system
SIM, C = f"qawk-sim-orch-{R}", f"o{R}c"
TOKEN = os.environ.get("QAWK_GATEWAY_TOKEN") or "orch-" + R
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


fleet = lambda fid: must("GET", f"/qawk/v1/fleets/{fid}")
sd = lambda i: must("GET", f"/qawk/v1/systemdeployments/{i}")
ended = lambda i: (lambda d: d["status"] in ("finished", "failed", "aborted") and d)(sd(i))


def centres():
    return {c["centre"]: c for c in must("GET", "/qawk/v1/centres")["content"] if c["centre"].startswith(C)}


def centre_by_centre(d):
    """Every system of a centre finished before any of the next one started."""
    runs = [r for r in d["runs"] if r.get("startedAt")]
    by = {}
    for r in runs:
        by.setdefault(r["centre"], []).append(r)
    order = sorted(by)
    for a, b in zip(order, order[1:]):
        last_a = max(r.get("finishedAt") or 1 << 62 for r in by[a])
        first_b = min(r["startedAt"] for r in by[b])
        if last_a > first_b:
            return False, f"{b} started before {a} was done"
    return True, " then ".join(f"{c} ({len(by[c])})" for c in order)


def main():
    print(f"  server {BASE}, run {R}\n")
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.enabled", {"value": True})
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.key", {"value": TOKEN})
    must("PUT", "/qawk/v1/centres/settings", {"field": "attribute.centerid"})
    beta = must("POST", "/qawk/v1/fleets", {"name": f"beta-{R}", "colour": "#e5a50a",
                                            "orchestrator": {"maxParallel": 1, "maxFailed": 0, "byCentre": True}})["id"]
    prod = must("POST", "/qawk/v1/fleets", {"name": f"prod-{R}", "colour": "#1c71d8", "upstreamId": beta,
                                            "gate": {"minDevices": 1, "minSuccess": 100, "soakMinutes": 0},
                                            "orchestrator": {"maxParallel": 2, "maxFailed": 0, "byCentre": True}})["id"]
    subprocess.run(["docker", "run", "-d", "--rm", "--name", SIM, "--network", "host", "--entrypoint", "qawk-sim", IMAGE,
                    "-url", BASE, "-token", TOKEN, "-prefix", "x" + R, "-interval", "3s",
                    "-install-min", "2s", "-install-max", "4s", "-centre-prefix", C,
                    # the neo-intel beside each system: a component no topology knows, so it
                    # stands alone -- in the same centre (each -system has centres of its own)
                    "-system", f"{KEY}:8:6hd=1,st05=2,hyper=1,neo=1:centers=4",
                    "-fail-where", f"{KEY}={KEY}-07,device_type=hyper,set=2.0"], check=True, capture_output=True)
    try:
        cs = until(lambda: (lambda m: len(m) == 4 and all(c["devices"] == 10 for c in m.values()) and m)(centres()), 120)
        check("four centres: two systems and two neo-intel each", bool(cs), str({k: v["devices"] for k, v in (cs or {}).items()}))
        must("PUT", "/qawk/v1/centres", {"centres": [C + "01", C + "02"], "fleetId": beta})
        must("PUT", "/qawk/v1/centres", {"centres": [C + "03", C + "04"], "fleetId": prod})
        got = until(lambda: fleet(beta)["members"] == 20 and fleet(prod)["members"] == 20, 60)
        check("c01 and c02 in beta, c03 and c04 in prod", bool(got))

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
        sy = until(lambda: (lambda x: len(x) == 8 and x)(must("GET", f"/qawk/v1/systemtypes/{tid}/systems")["content"]), 30)
        check("eight systems; the neo-intel belong to none", bool(sy) and fleet(beta)["inSystems"] == 16,
              f"{len(sy or [])} systems, beta {fleet(beta)['inSystems']} in systems")

        solo = make_set(f"solo-{R}", "2.0")
        sets = {c: make_set(f"{c}-{R}", "2.0") for c in ("6hd", "st05", "hyper")}
        man = must("POST", "/qawk/v1/manifests", {"name": f"sixhd-{R}-2.0", "systemTypeId": tid, "components": [
            {"componentType": "st05", "distributionSetId": sets["st05"], "order": 10},
            {"componentType": "hyper", "distributionSetId": sets["hyper"], "order": 10},
            {"componentType": "6hd", "distributionSetId": sets["6hd"], "order": 20}]})

        # beta: a set for the neo-intel, the manifest for the systems
        must("PUT", f"/qawk/v1/fleets/{beta}", {"distributionSetId": solo, "manifestId": man["id"]})
        f = fleet(beta)
        rel = f["release"] or {}
        check("beta's release carries the set and the manifest", rel.get("manifest") == man["name"]
              and f.get("manifest") == man["name"], f"{rel.get('distributionSet')} + {rel.get('manifest')}")
        s = f.get("systems") or {}
        check("and has started the orchestrator on beta's four systems, one centre at a time",
              s.get("total") == 4 and s.get("byCentre") is True and rel.get("systemDeploymentId"),
              f"{s.get('total')} systems, by centre {s.get('byCentre')}, centre {s.get('centre')}")
        d = until(lambda: ended(rel["systemDeploymentId"]), 400, 3) or sd(rel["systemDeploymentId"])
        check("beta's systems: all four updated", d["status"] == "finished" and d["counts"]["succeeded"] == 4, d["reason"])
        good, how = centre_by_centre(d)
        check("centre by centre: " + how, good, how)
        neo = until(lambda: must("GET", f"/rest/v1/targets?limit=1&q=installedds.name==solo-{R}")["total"] >= 4, 120)
        check("the neo-intel of beta run the release's set", bool(neo))
        f = until(lambda: (lambda x: (x["release"] or {}).get("status") == "completed" and x)(fleet(beta)), 120, 3)
        check("beta's release is complete: its neo-intel and its systems", bool(f),
              (fleet(beta)["release"] or {}).get("status"))
        g = must("GET", f"/qawk/v1/fleets/{prod}/gate?from={beta}")
        check("prod's gate looks at beta's systems too, and is open", g["open"] and "orchestrator took" in g["report"],
              g["report"].splitlines()[-1])

        # prod: promoted, the manifest comes along -- and 6hd-07's hyper fails
        r = must("POST", f"/qawk/v1/fleets/{prod}/promote", {"from": beta})
        check("promoted to prod, the manifest comes along", r.get("manifest") == man["name"] and r.get("systemDeploymentId"),
              f"{r.get('distributionSet')} + {r.get('manifest')}")
        d = until(lambda: ended(r["systemDeploymentId"]), 400, 3) or sd(r["systemDeploymentId"])
        runs = {x["system"]: x for x in d["runs"]}
        check("prod's systems, c03 first: 05 and 06 updated", all(runs.get(f"{KEY}-0{i}", {}).get("status") == "succeeded"
                                                                  for i in (5, 6)),
              ", ".join(f"{k} {v['status']}" for k, v in sorted(runs.items())))
        check("then c04: 07's hyper fails 2.0 and 07 goes back, more than prod allows",
              runs.get(f"{KEY}-07", {}).get("status") == "rolled_back" and d["status"] == "failed", d["reason"])
        f = until(lambda: (lambda x: (x["release"] or {}).get("status") == "halted" and x)(fleet(prod)), 90, 3)
        check("and prod's release halts, saying why", bool(f) and "orchestrator" in (f["release"] or {}).get("reason", ""),
              (fleet(prod)["release"] or {}).get("reason", "").splitlines()[-1:])

        # without the orchestrator: the systems are left alone
        lab = must("POST", "/qawk/v1/fleets", {"name": f"lab-{R}", "upstreamId": beta,
                                               "gate": {"minDevices": 1, "minSuccess": 100}})["id"]
        r = must("POST", f"/qawk/v1/fleets/{lab}/promote", {"from": beta, "orchestrator": False})
        check("promoted without the orchestrator: the set alone, no manifest, nothing for the systems",
              not r.get("manifest") and not r.get("systemDeploymentId"), f"{r.get('distributionSet')} + {r.get('manifest')!r}")

        # a fleet that promotes itself takes the manifest along
        auto = must("POST", "/qawk/v1/fleets", {"name": f"auto-{R}", "upstreamId": beta, "autoPromote": True,
                                                "gate": {"minDevices": 1, "minSuccess": 100}})["id"]
        f = until(lambda: (lambda x: x["release"] and x)(fleet(auto)), 60, 3)
        rel = (f or {}).get("release") or {}
        d = sd(rel["systemDeploymentId"]) if rel.get("systemDeploymentId") else {}
        check("a fleet promoting itself takes the manifest along; with no system of its own, it says so",
              rel.get("manifest") == man["name"] and d.get("status") == "finished" and "no system" in d.get("reason", ""),
              d.get("reason"))
    finally:
        subprocess.run(["docker", "rm", "-f", SIM], capture_output=True)
    print(f"\n  {ok} ok, {bad} failed")
    sys.exit(1 if bad else 0)


main()
