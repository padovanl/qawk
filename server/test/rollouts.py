#!/usr/bin/env python3

# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Luca Padovan

"""hawkBit's rollouts, end to end, with simulated devices.

    python3 server/test/rollouts.py [http://localhost:18080]

Needs a Qawk it may fill with test data and Docker, to run qawk-sim from the
Qawk image ($QAWK_IMAGE, qawk:next by default). 40 simulated devices with
ring=ro-<run>, and a rollout at a time over them:

  * four groups, next group at 100% success: the groups run one after the
    other, never two at once, and the rollout finishes with all 40 on it;
  * a broken set, pause over 20% errors: the first group fails, the rollout
    pauses, the other 30 devices are never sent it; retry makes a rollout of
    the failed ones only;
  * triggerNextGroup starts the next group before its time; pause stops new
    groups, resume goes on;
  * with rollout.approval.enabled a new rollout waits for approval: an
    operator cannot give it, a release manager can; deny is final;
  * stop ends a running rollout: no more groups start;
  * a rollout aims at a fleet too: targetFilterQuery fleet==...
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
SIM = f"qawk-sim-ro-{R}"
N = 40
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


def call(method, path, body=None, who=ADMIN, raw=None, ctype=None):
    h = {"Authorization": "Basic " + base64.b64encode(f"{who[0]}:{who[1]}".encode()).decode()}
    data = None
    if body is not None:
        h["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
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


def must(method, path, body=None, who=ADMIN):
    st, j = call(method, path, body, who)
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


def make_set(version, module):
    sm = must("POST", "/rest/v1/softwaremodules", [{"name": module, "version": version, "type": "application"}])[0]
    bd = "b" + uuid.uuid4().hex
    body = (f"--{bd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{module}.swu\"\r\n\r\n").encode() \
        + os.urandom(1024) + f"\r\n--{bd}--\r\n".encode()
    st, _ = call("POST", f"/rest/v1/softwaremodules/{sm['id']}/artifacts", raw=body,
                 ctype="multipart/form-data; boundary=" + bd)
    assert st == 201, st
    return must("POST", "/rest/v1/distributionsets",
                [{"name": "ro-" + R, "version": version, "type": "app", "modules": [{"id": sm["id"]}]}])[0]["id"]


QUERY = f"attribute.ring==ro-{R}"


def rollout(name, ds, groups, err_pct=20, ok_pct=100, who=ADMIN, query=QUERY):
    return must("POST", "/rest/v1/rollouts", {
        "name": f"{name}-{R}", "distributionSetId": ds, "targetFilterQuery": query, "amountGroups": groups,
        "type": "forced",
        "successCondition": {"condition": "THRESHOLD", "expression": str(ok_pct)},
        "successAction": {"action": "NEXTGROUP", "expression": ""},
        "errorCondition": {"condition": "THRESHOLD", "expression": str(err_pct)},
        "errorAction": {"action": "PAUSE", "expression": ""}}, who=who)["id"]


def ro(rid):
    return must("GET", f"/rest/v1/rollouts/{rid}")


def groups(rid):
    return must("GET", f"/rest/v1/rollouts/{rid}/deploygroups?limit=50&sort=id:ASC")["content"]


def status_is(rid, *want):
    return lambda: ro(rid)["status"] in want and ro(rid)


def installed(ds):
    q = urllib.parse.quote(f"{QUERY};installedds.id=={ds}")
    return must("GET", f"/rest/v1/targets?limit=1&q={q}")["total"]


def main():
    print(f"  server {BASE}, run {R}\n")
    token = os.environ.get("QAWK_GATEWAY_TOKEN") or "ro-" + R   # the server's own, on a server devices use
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.enabled", {"value": True})
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.key", {"value": token})
    rm, op = ("ro-rm-" + R, "passw0rd-r"), ("ro-op-" + R, "passw0rd-o")
    must("POST", "/qawk/v1/users", {"username": rm[0], "password": rm[1], "roles": ["release-manager"]})
    must("POST", "/qawk/v1/users", {"username": op[0], "password": op[1], "roles": ["operator"]})
    good1, good2, broken = make_set("1.0", "ro-app-" + R), make_set("1.1", "ro-app-" + R), make_set("2.0", "ro-broken-" + R)

    subprocess.run(["docker", "run", "-d", "--rm", "--name", SIM, "--network", "host", "--entrypoint", "qawk-sim",
                    IMAGE, "-url", BASE, "-token", token, "-prefix", "ro-" + R, "-interval", "3s",
                    "-install-min", "3s", "-install-max", "8s", "-fleet", f"ro-{R}:{N}"],
                   check=True, capture_output=True)
    try:
        q = urllib.parse.quote(QUERY)
        n = until(lambda: (lambda t: t == N and t)(must("GET", f"/rest/v1/targets?limit=1&q={q}")["total"]), 120)
        check("the simulated devices registered with their ring", n == N, str(n))

        # 1. groups one after the other
        r1 = rollout("seq", good1, 4)
        check("a rollout gets ready with its groups", bool(until(status_is(r1, "ready"), 60)), ro(r1)["status"])
        gs = groups(r1)
        check("four groups of ten", [g["totalTargets"] for g in gs] == [10] * 4, str([g["totalTargets"] for g in gs]))
        must("POST", f"/rest/v1/rollouts/{r1}/start")
        seen_two, t0 = False, time.time()
        while time.time() - t0 < 300 and ro(r1)["status"] != "finished":
            running = [g["name"] for g in groups(r1) if g["status"] == "running"]
            seen_two = seen_two or len(running) > 1
            time.sleep(1)
        check("the groups ran one after the other", not seen_two)
        check("the rollout finished", ro(r1)["status"] == "finished", ro(r1)["status"])
        check("all 40 run it", installed(good1) == N, str(installed(good1)))
        check("every group finished", all(g["status"] == "finished" for g in groups(r1)))

        # 2. a broken set pauses the rollout
        r2 = rollout("bad", broken, 4, err_pct=20)
        until(status_is(r2, "ready"), 60)
        must("POST", f"/rest/v1/rollouts/{r2}/start")
        p = until(status_is(r2, "paused"), 180)
        check("over 20% errors, the rollout pauses", bool(p), ro(r2)["status"])
        st = [g["status"] for g in groups(r2)]
        check("its first group is in error, the others never started", st[0] == "error" and all(s == "scheduled" for s in st[1:]),
              str(st))
        q = urllib.parse.quote(f"{QUERY};assignedds.id=={broken}")
        touched = must("GET", f"/rest/v1/targets?limit=1&q={q}")["total"]
        check("only the first group's ten were sent it", touched == 10, str(touched))
        # hawkBit retries a rollout that is over (finished or stopped), not one
        # that is only paused
        stc, _ = call("POST", f"/rest/v1/rollouts/{r2}/retry")
        check("a paused rollout cannot be retried", stc == 400, stc)
        must("POST", f"/rest/v1/rollouts/{r2}/stop")
        until(status_is(r2, "stopped"), 60)
        # the pause comes as soon as errors pass 20%, and stop cancels the
        # rest of the group: the ones that failed are those in error now
        failed = (ro(r2).get("totalTargetsPerStatus") or {}).get("error", 0)
        stc, j = call("POST", f"/rest/v1/rollouts/{r2}/retry")
        check("stopped, retry makes a rollout of exactly the ones that failed",
              stc == 201 and j and 0 < failed <= 10 and j.get("totalTargets") == failed,
              f"{stc} {j and j.get('totalTargets')} of {failed} in error")
        if j and j.get("id"):
            must("DELETE", f"/rest/v1/rollouts/{j['id']}")
        must("DELETE", f"/rest/v1/rollouts/{r2}")
        check("a stopped rollout can be deleted", bool(until(lambda: call("GET", f"/rest/v1/rollouts/{r2}")[0] == 404
                                                          or ro(r2)["status"] in ("deleting", "deleted"), 60)))

        # 3. triggerNextGroup, pause, resume
        r3 = rollout("manual", good2, 2)
        until(status_is(r3, "ready"), 60)
        must("POST", f"/rest/v1/rollouts/{r3}/start")
        until(lambda: groups(r3)[0]["status"] == "running", 60, 1)
        must("POST", f"/rest/v1/rollouts/{r3}/triggerNextGroup")
        check("triggerNextGroup starts the next group early", groups(r3)[1]["status"] == "running",
              str([g["status"] for g in groups(r3)]))
        must("POST", f"/rest/v1/rollouts/{r3}/pause")
        check("pause", ro(r3)["status"] == "paused", ro(r3)["status"])
        must("POST", f"/rest/v1/rollouts/{r3}/resume")
        check("resume", ro(r3)["status"] == "running", ro(r3)["status"])
        check("and it finishes", bool(until(status_is(r3, "finished"), 240)), ro(r3)["status"])
        check("all 40 on 1.1 -- the broken ones too, they rolled back", installed(good2) == N, str(installed(good2)))

        # 4. approval
        must("PUT", "/rest/v1/system/configs/rollout.approval.enabled", {"value": True})
        try:
            r4 = rollout("approve", good1, 2, who=op)
            w = until(status_is(r4, "waiting_for_approval"), 60)
            check("with approval on, a new rollout waits for it", bool(w), ro(r4)["status"])
            stc, _ = call("POST", f"/rest/v1/rollouts/{r4}/approve", {}, who=op)
            check("an operator cannot approve", stc == 403, stc)
            stc, _ = call("POST", f"/rest/v1/rollouts/{r4}/approve", {}, who=rm)
            check("a release manager can", stc in (200, 204) and ro(r4)["status"] == "ready", f"{stc} {ro(r4)['status']}")
            r5 = rollout("deny", good1, 2, who=op)
            until(status_is(r5, "waiting_for_approval"), 60)
            stc, _ = call("POST", f"/rest/v1/rollouts/{r5}/deny", {}, who=rm)
            check("deny", stc in (200, 204) and ro(r5)["status"] == "approval_denied", f"{stc} {ro(r5)['status']}")
            stc, _ = call("POST", f"/rest/v1/rollouts/{r5}/start")
            check("a denied rollout cannot start", stc >= 400, stc)
            for x in (r4, r5):
                call("DELETE", f"/rest/v1/rollouts/{x}")
        finally:
            must("PUT", "/rest/v1/system/configs/rollout.approval.enabled", {"value": False})

        # 5. stop
        r6 = rollout("stop", good1, 4)
        until(status_is(r6, "ready"), 60)
        must("POST", f"/rest/v1/rollouts/{r6}/start")
        until(lambda: groups(r6)[0]["status"] == "running", 60, 1)
        stc, _ = call("POST", f"/rest/v1/rollouts/{r6}/stop")
        s = until(status_is(r6, "stopped", "finished"), 120)
        check("stop ends a running rollout", stc in (200, 204) and bool(s), f"{stc} {ro(r6)['status']}")
        time.sleep(15)
        check("and no later group starts", all(g["status"] != "running" for g in groups(r6)[1:]),
              str([g["status"] for g in groups(r6)]))

        # 6. a rollout over a fleet
        fl = must("POST", "/qawk/v1/fleets", {"name": "ro-fleet-" + R, "rule": QUERY})["id"]
        until(lambda: must("GET", f"/qawk/v1/fleets/{fl}")["members"] == N, 60)
        r7 = rollout("fleet", good2, 2, query=f"fleet==ro-fleet-{R}")
        check("a rollout aims at a fleet with fleet==", ro(r7)["totalTargets"] == N or
              bool(until(lambda: ro(r7)["totalTargets"] == N, 30)), str(ro(r7)["totalTargets"]))
        call("DELETE", f"/rest/v1/rollouts/{r7}")
    finally:
        subprocess.run(["docker", "rm", "-f", SIM], capture_output=True)
    print(f"\n  {ok} ok, {bad} failed")
    sys.exit(1 if bad else 0)


main()
