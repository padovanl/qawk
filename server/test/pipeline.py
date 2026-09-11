#!/usr/bin/env python3
"""The release pipeline, end to end, with simulated devices.

    python3 ota/qawk/test/pipeline.py [http://localhost:18080]

Needs a Qawk it may fill with test data (a scratch instance: it creates
users, sets and fleets with a random suffix) and Docker, to run qawk-sim from
the Qawk image ($QAWK_IMAGE, qawk:next by default) next to it.

What it proves, in order:

  * fleets adopt the simulated devices by their ring attribute;
  * dev gets a release directly and delivers it to all its devices;
  * prod cannot take a release from dev: its upstream is beta;
  * beta's gate, checked on dev, opens; beta takes the release in waves;
  * prod needs approval: the person who asked cannot approve it, an operator
    cannot either, a second release manager can; prod then goes in waves;
  * expo, frozen, refuses a release; a device sent there remembers where it
    came from; thawed, expo delivers; sent home, the device gets its own
    fleet's release back;
  * a broken release halts dev by itself; beta's gate is then closed, cannot
    be forced by an operator nor without a reason, and when a release
    manager forces it, beta's first wave fails and beta halts too, with the
    rest of beta untouched;
  * a halted release resumes; every step is in the fleets' history and the
    audit log.
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
SIM = f"qawk-sim-{R}"
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
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        r = urllib.request.urlopen(req, timeout=60)
        st, b = r.status, r.read()
    except urllib.error.HTTPError as e:
        st, b = e.code, e.read()
    try:
        return st, json.loads(b) if b else None
    except ValueError:
        return st, None


def must(method, path, body=None, who=ADMIN, want=(200, 201, 202, 204)):
    st, j = call(method, path, body, who)
    if st not in want:
        raise SystemExit(f"{method} {path} -> {st} {j}")
    return j


def until(what, fn, timeout=300, step=3):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        last = fn()
        if last:
            return last
        time.sleep(step)
    return last


def fleet(fid):
    return must("GET", f"/qawk/v1/fleets/{fid}")


def make_set(name, version, module):
    sm = must("POST", "/rest/v1/softwaremodules", [{"name": module, "version": version, "type": "application"}])[0]
    bd = "b" + uuid.uuid4().hex
    body = (f"--{bd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{module}.swu\"\r\n\r\n").encode() \
        + os.urandom(2048) + f"\r\n--{bd}--\r\n".encode()
    st, _ = call("POST", f"/rest/v1/softwaremodules/{sm['id']}/artifacts", raw=body,
                 ctype="multipart/form-data; boundary=" + bd)
    assert st == 201, st
    return must("POST", "/rest/v1/distributionsets",
                [{"name": name, "version": version, "type": "app", "modules": [{"id": sm["id"]}]}])[0]["id"]


def main():
    print(f"  server {BASE}, run {R}\n")
    token = "pipe-" + R
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.enabled", {"value": True})
    must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.key", {"value": token})

    # people: two release managers (four eyes) and an operator
    a, b, op = ("rm-a-" + R, "passw0rd-a"), ("rm-b-" + R, "passw0rd-b"), ("op-" + R, "passw0rd-o")
    for u, roles in ((a, ["release-manager"]), (b, ["release-manager"]), (op, ["operator"])):
        must("POST", "/qawk/v1/users", {"username": u[0], "password": u[1], "roles": roles})

    # releases: two good ones and a broken one (qawk-sim fails "broken")
    v1 = make_set("app-" + R, "1.0", "hello-" + R)
    v2 = make_set("app-" + R, "1.1", "hello-" + R)
    vx = make_set("app-" + R, "2.0", "hello-broken-" + R)

    ring = lambda n: f"attribute.ring=={n}-{R}"
    dev = must("POST", "/qawk/v1/fleets", {"name": "dev-" + R, "rule": ring("dev")}, who=op)["id"]
    beta = must("POST", "/qawk/v1/fleets", {"name": "beta-" + R, "rule": ring("beta"), "upstreamId": dev,
                "wavePercent": 25, "errorThreshold": 10,
                "gate": {"minDevices": 5, "minSuccess": 90}}, who=op)["id"]
    prod = must("POST", "/qawk/v1/fleets", {"name": "prod-" + R, "rule": ring("prod"), "upstreamId": beta,
                "wavePercent": 20, "errorThreshold": 5,
                "gate": {"minDevices": 10, "minSuccess": 95, "approvalRequired": True}}, who=op)["id"]
    expo = must("POST", "/qawk/v1/fleets", {"name": "expo-" + R, "rule": ring("expo"), "temporary": True}, who=op)["id"]
    st, _ = call("POST", "/qawk/v1/fleets", {"name": "loop-" + R, "upstreamId": 999999}, who=op)
    check("an upstream that does not exist is refused", st == 400, st)
    st, _ = call("PUT", f"/qawk/v1/fleets/{dev}", {"upstreamId": prod}, who=op)
    check("a pipeline that loops is refused", st == 400, st)

    sizes = {"dev": 10, "beta": 20, "prod": 40, "expo": 5}
    args = ["docker", "run", "-d", "--rm", "--name", SIM, "--network", "host", "--entrypoint", "qawk-sim", IMAGE,
            "-url", BASE, "-token", token, "-prefix", "sim-" + R, "-interval", "3s",
            "-install-min", "2s", "-install-max", "5s"]
    for n, c in sizes.items():
        args += ["-fleet", f"{n}-{R}:{c}"]
    subprocess.run(args, check=True, capture_output=True)
    try:
        members = lambda: {n: fleet(f)["members"] for n, f in (("dev", dev), ("beta", beta), ("prod", prod), ("expo", expo))}
        got = until("adoption", lambda: members() == sizes and members(), 120)
        check("the fleets adopt the simulated devices by their ring", got == sizes, str(members()))

        # dev: direct
        must("PUT", f"/qawk/v1/fleets/{dev}", {"distributionSetId": v1}, who=op)
        f = until("dev", lambda: (lambda f: f["onRelease"] == sizes["dev"] and f)(fleet(dev)), 180)
        check("dev gets 1.0 directly, on every device", f and f["onRelease"] == 10, f and f["release"]["status"])
        st, _ = call("PUT", f"/qawk/v1/fleets/{beta}", {"distributionSetId": v1}, who=op)
        check("beta cannot be given a release directly: it takes them from dev", st == 400, st)

        st, j = call("POST", f"/qawk/v1/fleets/{prod}/promote", {"from": dev}, who=op)
        check("prod cannot take a release from dev", st == 400, st)

        g = must("GET", f"/qawk/v1/fleets/{beta}/gate?from={dev}")
        check("beta's gate, on dev, is open", g["open"], g["report"].replace("\n", " | "))
        rel = must("POST", f"/qawk/v1/fleets/{beta}/promote", {"from": dev}, who=op)
        check("beta takes 1.0 from dev", rel["status"] == "active", rel["status"])
        f = until("beta", lambda: (lambda f: f["onRelease"] == sizes["beta"] and f)(fleet(beta)), 300)
        check("beta delivers it to all 20, in waves of 25%", f and f["release"]["waves"] >= 4,
              f and f"{f['onRelease']}/20 in {f['release']['waves']} waves")

        st, rel = call("POST", f"/qawk/v1/fleets/{prod}/promote", {"from": beta}, who=a)
        check("prod needs approval: the promotion waits", st == 202 and rel["status"] == "waiting_for_approval",
              f"{st} {rel and rel['status']}")
        pend = must("GET", "/qawk/v1/releases?status=waiting_for_approval")
        check("it is in the approval queue", any(r["id"] == rel["id"] for r in pend["content"]))
        st, _ = call("POST", f"/qawk/v1/releases/{rel['id']}/approve", {}, who=a)
        check("who asked cannot approve (four eyes)", st == 403, st)
        st, _ = call("POST", f"/qawk/v1/releases/{rel['id']}/approve", {}, who=op)
        check("an operator cannot approve", st == 403, st)
        st, j = call("POST", f"/qawk/v1/releases/{rel['id']}/approve", {"note": "change CHG-" + R}, who=b)
        check("a second release manager approves", st == 200 and j["status"] == "active", st)
        f = until("prod", lambda: (lambda f: f["onRelease"] == sizes["prod"] and f)(fleet(prod)), 420)
        check("prod delivers it to all 40, in waves of 20%", f and f["release"]["waves"] >= 5,
              f and f"{f['onRelease']}/40 in {f['release']['waves']} waves")

        # expo: frozen, a device lent from prod, thawed, sent home
        must("PUT", f"/qawk/v1/fleets/{expo}/freeze", {"reason": "fair ISE-" + R}, who=op)
        st, j = call("PUT", f"/qawk/v1/fleets/{expo}", {"distributionSetId": v2}, who=op)
        check("frozen expo refuses a release", st == 409, f"{st} {j and j.get('message')}")
        lent = f"sim-{R}-prod-{R}-001"
        must("PUT", f"/qawk/v1/fleets/{expo}/targets", [lent], who=op)
        m = must("GET", f"/qawk/v1/fleets/{expo}/targets?limit=50")
        home = next((x["home"] for x in m["content"] if x["controllerId"] == lent), None)
        check("a device sent to expo remembers its fleet", home == "prod-" + R, str(home))
        must("DELETE", f"/qawk/v1/fleets/{expo}/freeze", who=op)
        must("PUT", f"/qawk/v1/fleets/{expo}", {"distributionSetId": v2}, who=op)
        f = until("expo", lambda: (lambda f: f["onRelease"] == 6 and f)(fleet(expo)), 180)
        check("thawed, expo delivers 1.1 to its 6 devices", f and f["onRelease"] == 6, f and str(f["onRelease"]))
        j = must("POST", f"/qawk/v1/fleets/{expo}/return", {"controllerIds": [lent]}, who=op)
        check("the lent device goes home", j["returned"] == 1, str(j))
        t = until("home", lambda: (lambda t: t.get("installedDistributionSet") and t)(
            {"installedDistributionSet": (must("GET", f"/rest/v1/targets/{lent}/installedDS") or {}).get("version") == "1.0"}), 120)
        check("and gets prod's release, 1.0, back", bool(t))

        # a broken release
        must("PUT", f"/qawk/v1/fleets/{dev}", {"distributionSetId": vx}, who=op)
        f = until("halt", lambda: (lambda f: f["release"]["status"] == "halted" and f)(fleet(dev)), 180)
        check("a broken release halts dev by itself", bool(f), f and f["release"]["reason"])
        g = must("GET", f"/qawk/v1/fleets/{beta}/gate?from={dev}")
        check("beta's gate is closed", not g["open"], g["report"].replace("\n", " | "))
        st, j = call("POST", f"/qawk/v1/fleets/{beta}/promote", {"from": dev}, who=op)
        check("promoting through it is refused", st == 409, st)
        st, _ = call("POST", f"/qawk/v1/fleets/{beta}/promote", {"from": dev, "force": True, "reason": "x"}, who=op)
        check("an operator cannot force it", st == 403, st)
        st, _ = call("POST", f"/qawk/v1/fleets/{beta}/promote", {"from": dev, "force": True}, who=a)
        check("a release manager cannot force it without a reason", st == 400, st)
        st, rel = call("POST", f"/qawk/v1/fleets/{beta}/promote",
                       {"from": dev, "force": True, "reason": "test the halt"}, who=a)
        check("with a reason, they can", st == 200 and rel["forced"], st)
        f = until("beta halt", lambda: (lambda f: f["release"]["status"] == "halted" and f)(fleet(beta)), 180)
        p = f and f["progress"]
        check("beta's first wave fails, and beta halts", bool(f), f and f["release"]["reason"])
        check("with the rest of beta untouched", p and p["failed"] <= 5 and p["active"] == 0
              and fleet(beta)["members"] - p["failed"] >= 15, p and str(p))
        must("POST", f"/qawk/v1/fleets/{dev}/resume", {}, who=op)
        check("a halted release resumes", fleet(dev)["release"]["status"] == "active")

        h = must("GET", f"/qawk/v1/fleets/{beta}/releases")
        check("beta's history has both releases, the forced one marked",
              len(h["content"]) == 2 and h["content"][0]["forced"] and h["content"][1]["status"] == "superseded",
              " / ".join(f"{r['distributionSet']} {r['status']}" for r in h["content"]))
        au = must("GET", f"/qawk/v1/audit?q=user=={b[0]}")
        check("the approval is in the audit log", any("/approve" in e["path"] for e in au["content"]))
    finally:
        subprocess.run(["docker", "rm", "-f", SIM], capture_output=True)
    print(f"\n  {ok} ok, {bad} failed")
    sys.exit(1 if bad else 0)


main()
