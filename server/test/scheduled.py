#!/usr/bin/env python3
"""Scheduled deployments, end to end, with simulated devices.

    python3 ota/qawk/test/scheduled.py [http://localhost:18080]

Needs a Qawk it may fill with test data and Docker, to run qawk-sim from the
Qawk image ($QAWK_IMAGE, qawk:next by default): ten simulated devices, which
honour a maintenance window as SWUpdate does, and two probes this script
reads the device API for itself.

  * a maintenance window half given, with a cron it cannot read, a 25-hour
    duration, a named zone, or only in the past, is refused -- hawkBit's
    error code and all;
  * with a window opening in a minute or two: the device is told to download
    and skip the install ("unavailable"), the action says when the window
    opens (nextStartAt), no simulated device installs; once it opens the
    device is told "available" and to install, the link changes, and all ten
    install inside the window;
  * timeforced: "attempt" until the force time, "forced" after, the link
    changing;
  * downloadonly: the devices say they downloaded, and the actions close;
  * a rollout with startAt stays ready until then, and starts by itself;
  * a rollout of type timeforced hands its actions that type.
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
SIM = f"qawk-sim-sch-{R}"
N = 10
TOKEN = "sch-" + R
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


def request(method, url, body=None, auth=None, raw=None, ctype=None):
    h = {"Authorization": auth or "Basic " + base64.b64encode(f"{ADMIN[0]}:{ADMIN[1]}".encode()).decode()}
    data = None
    if body is not None:
        h["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if raw is not None:
        h["Content-Type"], data = ctype, raw
    try:
        r = urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=h), timeout=60)
        st, b = r.status, r.read()
    except urllib.error.HTTPError as e:
        st, b = e.code, e.read()
    try:
        return st, json.loads(b) if b else None
    except ValueError:
        return st, None


def call(method, path, body=None, **kw):
    return request(method, BASE + path, body, **kw)


def must(method, path, body=None):
    st, j = call(method, path, body)
    if st not in (200, 201, 202, 204):
        raise SystemExit(f"{method} {path} -> {st} {j}")
    return j


def ddi(url):
    if not url.startswith("http"):
        url = f"{BASE}/DEFAULT/controller/v1/{url}"
    return request("GET", url, auth="GatewayToken " + TOKEN)[1]


def deployment(cid):
    root = ddi(cid) or {}
    href = ((root.get("_links") or {}).get("deploymentBase") or {}).get("href")
    return href, (ddi(href) if href else {}) or {}


def until(fn, timeout=300, step=2):
    t0, last = time.time(), None
    while time.time() - t0 < timeout:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


def sleep_until(t):
    while time.time() < t:
        time.sleep(min(2, max(0.1, t - time.time())))


def make_set(version):
    sm = must("POST", "/rest/v1/softwaremodules", [{"name": "sch-" + R, "version": version, "type": "application"}])[0]
    bd = "b" + uuid.uuid4().hex
    body = (f"--{bd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"sch.swu\"\r\n\r\n").encode() \
        + os.urandom(1024) + f"\r\n--{bd}--\r\n".encode()
    st, _ = call("POST", f"/rest/v1/softwaremodules/{sm['id']}/artifacts", raw=body,
                 ctype="multipart/form-data; boundary=" + bd)
    assert st == 201, st
    return must("POST", "/rest/v1/distributionsets",
                [{"name": "sch-" + R, "version": version, "type": "app", "modules": [{"id": sm["id"]}]}])[0]["id"]


def assign(ds, targets, typ="forced", mw=None, ft=None):
    body = []
    for t in targets:
        b = {"id": t, "type": typ}
        if mw:
            b["maintenanceWindow"] = mw
        if ft:
            b["forcetime"] = ft
        body.append(b)
    return call("POST", f"/rest/v1/distributionsets/{ds}/assignedTargets", body)


def last_action(cid):
    a = (must("GET", f"/rest/v1/targets/{cid}/actions?limit=1&sort=id:DESC")["content"] or [{}])[0]
    return must("GET", f"/rest/v1/targets/{cid}/actions/{a['id']}") if a.get("id") else {}


def count(q):
    return must("GET", "/rest/v1/targets?limit=1&q=" + urllib.parse.quote(q))["total"]


def main():
    print(f"  server {BASE}, run {R}\n")
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.enabled", {"value": True})
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.key", {"value": TOKEN})
    v1, v2 = make_set("1.0"), make_set("1.1")
    probe1, probe2 = f"sch-{R}-probe1", f"sch-{R}-probe2"
    ddi(probe1)
    ddi(probe2)
    sims = [f"s{R}-sch-{i:03d}" for i in range(1, N + 1)]
    mine = f"controllerId==s{R}-*"

    for mw, what in (
            ({"schedule": "0 0 2 * * ?"}, "a schedule with no duration nor timezone"),
            ({"schedule": "0 0 2 * *", "duration": "01:00:00", "timezone": "+00:00"}, "a five-field (Unix) cron"),
            ({"schedule": "0 0 2 * * ?", "duration": "25:00:00", "timezone": "+00:00"}, "a 25-hour duration"),
            ({"schedule": "0 0 2 * * ?", "duration": "01:00:00", "timezone": "CET"}, "a named zone"),
            ({"schedule": "0 0 0 1 1 ? 2000", "duration": "01:00:00", "timezone": "+00:00"}, "a window only in the past")):
        st, j = assign(v1, [probe1], mw=mw)
        check(f"refused: {what}", st == 400 and (j or {}).get("errorCode") == "hawkbit.server.error.maintenanceScheduleInvalid",
              f"{st} {(j or {}).get('message', '')[:70]}")

    subprocess.run(["docker", "run", "-d", "--rm", "--name", SIM, "--network", "host", "--entrypoint", "qawk-sim",
                    IMAGE, "-url", BASE, "-token", TOKEN, "-prefix", "s" + R, "-interval", "3s",
                    "-install-min", "2s", "-install-max", "5s", "-fleet", f"sch:{N}"], check=True, capture_output=True)
    try:
        n = until(lambda: (lambda c: c == N and c)(count(mine)), 120)
        check("the simulated devices registered", n == N, str(n))

        # --- a maintenance window that opens in a minute or two
        start = (int(time.time()) // 60 + 2) * 60
        if start - time.time() < 70:
            start += 60
        g = time.gmtime(start)
        mw = {"schedule": f"0 {g.tm_min} {g.tm_hour} * * ?", "duration": "00:02:00", "timezone": "+00:00"}
        st, _ = assign(v1, sims + [probe1], mw=mw)
        check(f"assigned with a window at {time.strftime('%H:%M', g)} UTC for two minutes", st == 200, st)
        a = last_action(probe1)
        nxt = (a.get("maintenanceWindow") or {}).get("nextStartAt")
        check("the action says when its window opens (nextStartAt)", nxt == start * 1000, f"{nxt} vs {start * 1000}")
        href1, d = deployment(probe1)
        dep = d.get("deployment") or {}
        check("closed: download, but skip the install, the window unavailable",
              dep.get("download") == "forced" and dep.get("update") == "skip" and dep.get("maintenanceWindow") == "unavailable",
              f"{dep.get('download')}/{dep.get('update')}/{dep.get('maintenanceWindow')}")
        time.sleep(15)
        check("no simulated device installs before its window", count(f"{mine};installedds.id=={v1}") == 0)
        sleep_until(start + 2)
        href2, d = deployment(probe1)
        dep = d.get("deployment") or {}
        check("open: install, the window available", dep.get("update") == "forced" and dep.get("maintenanceWindow") == "available",
              f"{dep.get('update')}/{dep.get('maintenanceWindow')}")
        check("and the link changed, so a caching device reads it again", href1 != href2)
        done = until(lambda: (lambda c: c == N and c)(count(f"{mine};installedds.id=={v1}")), 110, 3)
        check("all ten install inside the window", done == N and time.time() < start + 120, f"{done}")

        # --- timeforced
        ft = int((time.time() + 25) * 1000)
        assign(v2, [probe2], typ="timeforced", ft=ft)
        h1, d = deployment(probe2)
        dep = d.get("deployment") or {}
        check("timeforced, before its time: attempt", dep.get("download") == "attempt" and dep.get("update") == "attempt",
              f"{dep.get('download')}/{dep.get('update')}")
        sleep_until(ft / 1000 + 3)
        h2, d = deployment(probe2)
        dep = d.get("deployment") or {}
        check("after it: forced, under a new link", dep.get("update") == "forced" and h1 != h2, f"{dep.get('update')}")

        # --- downloadonly
        st, _ = assign(v2, sims, typ="downloadonly")
        # hawkBit closes a download-only action at "downloaded", and leaves it
        # in that status: it is not "finished", nothing was installed
        closed = until(lambda: all((lambda a: a.get("status") == "downloaded" and not a.get("active", True))(last_action(s))
                                   for s in sims) and True, 90, 3)
        check("downloadonly: the devices say downloaded, and the actions close there", bool(closed) and st == 200,
              str([(last_action(s).get("status"), last_action(s).get("active")) for s in sims[:3]]))

        # --- a rollout that starts at a set time
        t0 = int((time.time() + 40) * 1000)
        rid = must("POST", "/rest/v1/rollouts", {
            "name": "at-" + R, "distributionSetId": v2, "targetFilterQuery": mine, "amountGroups": 2,
            "type": "forced", "startAt": t0,
            "successCondition": {"condition": "THRESHOLD", "expression": "100"},
            "successAction": {"action": "NEXTGROUP", "expression": ""},
            "errorCondition": {"condition": "THRESHOLD", "expression": "20"},
            "errorAction": {"action": "PAUSE", "expression": ""}})["id"]
        ro = lambda: must("GET", f"/rest/v1/rollouts/{rid}")
        until(lambda: ro()["status"] == "ready", 60)
        check("a rollout with startAt says it", ro().get("startAt") == t0, str(ro().get("startAt")))
        sleep_until(t0 / 1000 - 8)
        check("before its time it waits, ready", ro()["status"] == "ready", ro()["status"])
        st = until(lambda: ro()["status"] in ("running", "finished") and ro()["status"], 60, 1)
        check("at its time it starts by itself", bool(st), ro()["status"])
        check("and finishes", bool(until(lambda: ro()["status"] == "finished", 180, 3)), ro()["status"])
        check("all ten on 1.1", count(f"{mine};installedds.id=={v2}") == N)

        # --- a timeforced rollout
        ft = int((time.time() + 600) * 1000)
        rid = must("POST", "/rest/v1/rollouts", {
            "name": "tf-" + R, "distributionSetId": v1, "targetFilterQuery": mine, "amountGroups": 1,
            "type": "timeforced", "forcetime": ft})["id"]
        until(lambda: ro()["status"] == "ready", 60)
        must("POST", f"/rest/v1/rollouts/{rid}/start")
        a = until(lambda: (lambda a: a.get("rollout") and a)(last_action(sims[0])), 30, 1) or {}
        check("a timeforced rollout hands its actions that type", a.get("forceType") == "timeforced",
              f"{a.get('forceType')} {a.get('forceTime')}")
        call("POST", f"/rest/v1/rollouts/{rid}/stop")
    finally:
        subprocess.run(["docker", "rm", "-f", SIM], capture_output=True)
    print(f"\n  {ok} ok, {bad} failed")
    sys.exit(1 if bad else 0)


main()
