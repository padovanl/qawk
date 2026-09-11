#!/usr/bin/env python3
"""Systems -- updated as a whole, after Mender Orchestrator -- end to end.

    python3 ota/qawk/test/systems.py [http://localhost:18080]

Needs a Qawk it may fill with test data, and Docker, to run qawk-sim from the
Qawk image ($QAWK_IMAGE, qawk:next by default). Four systems, each a 6hd
with two st05 and a hyper under it; the hyper of the third fails whatever it
is given.

  * a topology and a manifest come in as Mender's YAML, and go out again;
  * the systems of the type are found from what the devices report;
  * a first deployment puts every system on 1.0;
  * the 2.0 deployment runs two systems at a time; inside each, the st05 and
    the hyper (order 10) finish before the 6hd (order 20) is sent anything;
    system 03's hyper fails, and system 03 goes back to 1.0 as a whole --
    its st05 too -- while the others end on 2.0;
  * a deployment that allows no failure stops starting systems after one;
  * one system is rolled back by hand.
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
SYS = "ctr" + R                    # the attribute naming each device's system
SIM = f"qawk-sim-sys-{R}"
TOKEN = "sys-" + R
ok = bad = 0


def check(name, cond, extra=""):
    global ok, bad
    if cond:
        ok += 1
        print(f"  ok   {name}  {extra}".rstrip())
    else:
        bad += 1
        print(f"  FAIL {name}  {extra}".rstrip())
    return cond


def call(method, path, body=None, raw=None, ctype=None):
    h = {"Authorization": "Basic " + base64.b64encode(f"{ADMIN[0]}:{ADMIN[1]}".encode()).decode()}
    data = None
    if body is not None:
        h["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
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


def until(fn, timeout=300, step=2):
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
    body = (f"--{bd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{module}.swu\"\r\n\r\n").encode() \
        + os.urandom(1024) + f"\r\n--{bd}--\r\n".encode()
    st, _ = call("POST", f"/rest/v1/softwaremodules/{sm['id']}/artifacts", raw=body, ctype="multipart/form-data; boundary=" + bd)
    assert st == 201, st
    return must("POST", "/rest/v1/distributionsets",
                [{"name": module, "version": version, "type": "app", "modules": [{"id": sm["id"]}]}])[0]["id"]


def installed(cid):
    st, d = call("GET", f"/rest/v1/targets/{cid}/installedDS")
    return f"{d['name']}:{d['version']}" if st == 200 and isinstance(d, dict) and d else None


def main():
    print(f"  server {BASE}, run {R}\n")
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.enabled", {"value": True})
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.key", {"value": TOKEN})
    comps = {"st05": f"st05-{R}", "hyper": f"hyper-{R}", "6hd": f"sixhd-{R}"}
    for c, mod in comps.items():
        make_set(mod, "1.0")
        make_set(mod, "2.0")

    topo = f"""api_version: mender/v1
kind: topology
system_type: sixhd-system-{R}
qawk_system_key: attribute.{SYS}
components:
  - component_type: st05
    qawk_match: attribute.device_type==st05
  - component_type: hyper
    qawk_match: attribute.device_type==hyper
  - component_type: 6hd
    qawk_match: attribute.device_type==6hd
"""
    st, t = call("POST", "/qawk/v1/systemtypes/import", raw=topo, ctype="application/yaml")
    check("a Mender topology comes in", st == 200 and len(t["components"]) == 3, st)
    tid = t["id"]
    st, y = call("GET", f"/qawk/v1/systemtypes/{tid}/topology.yaml")
    check("and goes out as YAML", st == 200 and "kind: topology" in str(y) and f"attribute.{SYS}" in str(y), st)

    def manifest(version):
        body = f"""api_version: mender/v1
kind: manifest
name: sixhd-system-{R}-{version}
system_types_compatible: [sixhd-system-{R}]
component_types:
  st05:  {{artifact_name: "{comps['st05']}:{version}", update_strategy: {{order: 10}}}}
  hyper: {{artifact_name: "{comps['hyper']}:{version}", update_strategy: {{order: 10}}}}
  6hd:   {{artifact_name: "{comps['6hd']}:{version}", update_strategy: {{order: 20}}}}
"""
        st, m = call("POST", "/qawk/v1/manifests/import", raw=body, ctype="application/yaml")
        assert st == 201, (st, m)
        return m
    m1, m2 = manifest("1.0"), manifest("2.0")
    check("a Mender manifest comes in, with the orders", [c["order"] for c in m2["components"]] == [10, 10, 20],
          str([(c["componentType"], c["order"]) for c in m2["components"]]))

    subprocess.run(["docker", "run", "-d", "--rm", "--name", SIM, "--network", "host", "--entrypoint", "qawk-sim", IMAGE,
                    "-url", BASE, "-token", TOKEN, "-prefix", "s" + R, "-interval", "3s",
                    "-install-min", "2s", "-install-max", "4s",
                    "-system", f"{SYS}:4:6hd=1,st05=2,hyper=1",
                    "-fail-where", f"{SYS}={SYS}-03,device_type=hyper"], check=True, capture_output=True)
    try:
        sy = until(lambda: (lambda s: len(s) == 4 and all(x["devices"] == 4 for x in s) and s)(
            must("GET", f"/qawk/v1/systemtypes/{tid}/systems")["content"]), 120)
        check("four systems found from what their devices report: a 6hd, two st05, a hyper", bool(sy),
              str([(x["system"], x["components"]) for x in (sy or [])]))

        def deploy(name, m, **kw):
            body = {"name": f"{name}-{R}", "manifestId": m["id"], **kw}
            d = must("POST", "/qawk/v1/systemdeployments", body)
            must("POST", f"/qawk/v1/systemdeployments/{d['id']}/start")
            return d["id"]

        def sd(i):
            return must("GET", f"/qawk/v1/systemdeployments/{i}")

        # 1.0 everywhere -- except system 03, whose hyper fails even this
        d1 = deploy("v1", m1, maxParallel=4, maxFailed=4)
        f = until(lambda: (lambda d: d["status"] in ("finished", "failed") and d)(sd(d1)), 240, 3)
        check("the first deployment ends", bool(f), f and f["reason"])

        # the 2.0 deployment: two at a time, orders in sequence, 03 rolled back
        d2 = deploy("v2", m2, maxParallel=2, maxFailed=2)
        most, early_hd, shown = 0, False, False
        t0 = time.time()
        while time.time() - t0 < 300:
            d = sd(d2)
            if not shown and d["status"] == "running":
                shown = any(x["kind"] == "system" and f"v2-{R}" in x["title"]
                            for x in must("GET", "/qawk/v1/deployments")["content"])
            most = max(most, d["counts"]["running"] + d["counts"]["rolling_back"])
            for r in d["runs"]:
                if r["status"] == "running" and r["currentOrder"] == 10:
                    hd = next((c for c in r["components"] if c["componentType"] == "6hd"), None)
                    if hd and hd["onSet"] > 0 and r["system"] != f"{SYS}-03":
                        # an hd on 2.0 while its terminals are still at order 10
                        early_hd = early_hd or installed_hd_v2(r["system"])
            if d["status"] in ("finished", "failed"):
                break
            time.sleep(2)
        d = sd(d2)
        runs = {r["system"]: r for r in d["runs"]}
        check("never more than two systems at once", most <= 2, str(most))
        check("no hd is sent 2.0 before its terminals are done", not early_hd)
        check("system 03 is rolled back, the others updated",
              runs[f"{SYS}-03"]["status"] == "rolled_back"
              and all(runs[f"{SYS}-{k:02d}"]["status"] == "succeeded" for k in (1, 2, 4)),
              str({k: v["status"] for k, v in runs.items()}))
        check("the deployment says so", d["status"] == "finished" and "1 rolled back" in d["reason"], d["reason"])
        st05_03 = f"s{R}-{SYS}-03-st05-1"
        check("system 03's st05, updated before its hyper failed, is back on 1.0",
              installed(st05_03) == f"{comps['st05']}:1.0", installed(st05_03))
        # its hyper failed 1.0 as well: its hd were sent nothing, ever
        hd_03 = f"s{R}-{SYS}-03-6hd-1"
        n03 = must("GET", f"/rest/v1/targets/{hd_03}/actions?limit=1")["total"]
        check("and its hd were never sent anything: order 20 never came", n03 == 0, f"{n03} actions")
        check("system 01's 6hd runs 2.0", installed(f"s{R}-{SYS}-01-6hd-1") == f"{comps['6hd']}:2.0",
              installed(f"s{R}-{SYS}-01-6hd-1"))

        # allow no failure: after 03, 04 is not started
        d3 = deploy("strict", m2, maxParallel=1, maxFailed=0, systems=[f"{SYS}-03", f"{SYS}-04"])
        f = until(lambda: (lambda d: d["status"] in ("finished", "failed") and d)(sd(d3)), 240, 3)
        runs = {r["system"]: r["status"] for r in (f or {}).get("runs", [])}
        check("with no failure allowed, the deployment stops after system 03", bool(f) and f["status"] == "failed"
              and runs.get(f"{SYS}-03") == "rolled_back" and runs.get(f"{SYS}-04") in ("skipped", "succeeded"),
              f"{f and f['status']} {runs}")

        # one system back by hand
        run01 = next(r for r in sd(d2)["runs"] if r["system"] == f"{SYS}-01")
        st, _ = call("POST", f"/qawk/v1/systemdeployments/{d2}/runs/{run01['id']}/rollback", {"reason": "test"})
        check("a system can be rolled back by hand", st == 200, st)
        back = until(lambda: installed(f"s{R}-{SYS}-01-6hd-1") == f"{comps['6hd']}:1.0", 120, 3)
        check("and its devices go back to 1.0", bool(back), installed(f"s{R}-{SYS}-01-6hd-1"))
        check("In progress showed the 2.0 deployment while it ran", shown)
    finally:
        subprocess.run(["docker", "rm", "-f", SIM], capture_output=True)
    print(f"\n  {ok} ok, {bad} failed")
    sys.exit(1 if bad else 0)


def installed_hd_v2(system):
    cid = f"s{R}-{system}-6hd-1"
    v = installed(cid)
    return bool(v and v.endswith(":2.0"))


main()
