#!/usr/bin/env python3
"""Sample data for the Qawk demo -- run by demo/start.sh; safe to run again.

  --stage base      the gateway token, the catalogue, the channels, the
                    system type and its manifests

No users besides the administrator: to have some, give the server a users
file (QAWK_USERS_FILE, see server/README.md).
  --stage devices   once the simulated devices have registered: the centres
                    in channels, and a first release in dev
  --stage all       both

Only the Python standard library.
"""
import argparse
import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--url", default=os.environ.get("QAWK_URL", "http://localhost:8080"))
ap.add_argument("--user", default=os.environ.get("QAWK_ADMIN_USER", "admin"))
ap.add_argument("--password", default=os.environ.get("QAWK_ADMIN_PASSWORD", "changeme"))
ap.add_argument("--token", default=os.environ.get("QAWK_GATEWAY_TOKEN", ""), help="the gateway token the devices use")
ap.add_argument("--stage", choices=["base", "devices", "all"], default="all")
A = ap.parse_args()

AUTH = "Basic " + base64.b64encode(f"{A.user}:{A.password}".encode()).decode()


def call(method, path, body=None, raw=None, ctype=None):
    headers = {"Authorization": AUTH}
    data = None
    if body is not None:
        headers["Content-Type"], data = "application/json", json.dumps(body).encode()
    if raw is not None:
        headers["Content-Type"], data = ctype, raw.encode() if isinstance(raw, str) else raw
    try:
        with urllib.request.urlopen(urllib.request.Request(A.url + path, data=data, method=method, headers=headers),
                                    timeout=60) as r:
            status, text = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, text = e.code, e.read()
    try:
        return status, json.loads(text) if text else None
    except ValueError:
        return status, text.decode(errors="replace")


def must(method, path, body=None, **kw):
    status, out = call(method, path, body, **kw)
    if status >= 300:
        raise SystemExit(f"{method} {path}: {status} {out}")
    return out


def say(msg):
    print("    " + msg)


def q(expr):
    return urllib.parse.quote(expr)


# ------------------------------------------------------------------ base
def gateway():
    if A.token:
        must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.enabled", {"value": True})
        must("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.key", {"value": A.token})
    # the simulated devices poll every 30 s: the console moves while you watch
    must("PUT", "/rest/v1/system/configs/pollingTime", {"value": "00:00:30"})
    say("gateway token set; devices poll every 30 s")


def make_set(name, version, kind="app"):
    """A distribution set with one module and a small made-up artifact."""
    found = must("GET", f"/rest/v1/distributionsets?limit=1&q={q(f'name=={name};version=={version}')}")
    if found["total"]:
        return found["content"][0]["id"]
    mtype = "os" if kind == "os" else "application"
    sm = must("POST", "/rest/v1/softwaremodules", [{"name": name, "version": version, "type": mtype,
                                                    "vendor": "Qawk demo"}])[0]
    bd = "b" + uuid.uuid4().hex
    body = (f"--{bd}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}-{version}.bin\"\r\n\r\n").encode() \
        + os.urandom(4096) + f"\r\n--{bd}--\r\n".encode()
    must("POST", f"/rest/v1/softwaremodules/{sm['id']}/artifacts", raw=body, ctype="multipart/form-data; boundary=" + bd)
    return must("POST", "/rest/v1/distributionsets",
                [{"name": name, "version": version, "type": kind, "modules": [{"id": sm["id"]}]}])[0]["id"]


def catalogue():
    sets = [("app", "1.0.0"), ("app", "1.1.0"), ("app", "1.2.0"),
            # the simulated devices fail anything named "broken": a release that halts
            ("app-broken", "1.3.0"),
            ("device2-fw", "1.0"), ("device2-fw", "2.0"), ("device3-fw", "1.0"), ("device3-fw", "2.0")]
    for name, version in sets:
        make_set(name, version)
    make_set("os", "1.0.0", "os")
    make_set("os", "1.1.0", "os")
    say(f"catalogue: {len(sets) + 2} distribution sets")


def channels():
    have = {f["name"]: f["id"] for f in must("GET", "/qawk/v1/fleets")["content"]}
    ring = lambda n: f"attribute.ring=={n}"

    def fleet(name, **kw):
        if name not in have:
            have[name] = must("POST", "/qawk/v1/fleets", {"name": name, "rule": ring(name), **kw})["id"]
        return have[name]

    fleet("dev", colour="#3e9b4f", description="the lab: takes releases directly")
    fleet("beta", colour="#e5a50a", description="friendly sites", upstreamId=have["dev"], wavePercent=25,
          errorThreshold=10, gate={"minDevices": 10, "minSuccess": 90})
    fleet("prod", colour="#1c71d8", description="everyone else", upstreamId=have["beta"], wavePercent=20,
          errorThreshold=5, gate={"minDevices": 20, "minSuccess": 95, "approvalRequired": True})
    fleet("expo", colour="#9141ac", description="machines lent to a trade show", temporary=True)
    say("channels: dev → beta → prod (approval required), expo")


TOPOLOGY = """api_version: mender/v1
kind: topology
system_type: device-system
qawk_system_key: attribute.device
components:
  - component_type: device1
    qawk_match: attribute.device_type==device1
  - component_type: device2
    qawk_match: attribute.device_type==device2
  - component_type: device3
    qawk_match: attribute.device_type==device3
"""


def manifest(version, app):
    name = f"device-system-{version}"
    if any(m["name"] == name for m in must("GET", "/qawk/v1/manifests")["content"]):
        return
    yaml = f"""api_version: mender/v1
kind: manifest
name: {name}
system_types_compatible: [device-system]
component_types:
  device2: {{artifact_name: "device2-fw:{version}", update_strategy: {{order: 10}}}}
  device3: {{artifact_name: "device3-fw:{version}", update_strategy: {{order: 10}}}}
  device1: {{artifact_name: "app:{app}", update_strategy: {{order: 20}}}}
"""
    must("POST", "/qawk/v1/manifests/import", raw=yaml, ctype="application/yaml")


def systems():
    if not any(t["name"] == "device-system" for t in must("GET", "/qawk/v1/systemtypes")["content"]):
        must("POST", "/qawk/v1/systemtypes/import", raw=TOPOLOGY, ctype="application/yaml")
    must("PUT", "/qawk/v1/centres/settings", {"field": "attribute.centerid"})
    manifest("1.0", "1.0.0")
    manifest("2.0", "1.1.0")
    say("system type device-system (device1 above two device2 and a device3), manifests 1.0 and 2.0")


# ------------------------------------------------------------------ devices
def registered(n, secs=180):
    t0 = time.time()
    while time.time() - t0 < secs:
        total = must("GET", "/rest/v1/targets?limit=1")["total"]
        if total >= n:
            return total
        time.sleep(5)
    return must("GET", "/rest/v1/targets?limit=1")["total"]


def devices():
    say(f"{registered(60)} devices registered")
    fleets = {f["name"]: f for f in must("GET", "/qawk/v1/fleets")["content"]}
    centres = {c["centre"] for c in must("GET", "/qawk/v1/centres")["content"]}
    placed = []
    for centre, channel in (("c01", "beta"), ("c02", "beta"), ("c03", "prod"), ("c04", "prod")):
        if centre in centres:
            must("PUT", "/qawk/v1/centres", {"centres": [centre], "fleetId": fleets[channel]["id"]})
            placed.append(f"{centre}→{channel}")
    say("centres: " + (", ".join(placed) or "none reported yet (run demo/start.sh seed in a minute)"))
    dev = fleets["dev"]
    if not dev.get("distributionSet"):
        must("PUT", f"/qawk/v1/fleets/{dev['id']}", {"distributionSetId": make_set("app", "1.1.0")})
        say("dev is given app 1.1.0: watch it on the dashboard")


if __name__ == "__main__":
    if A.stage in ("base", "all"):
        gateway()
        catalogue()
        channels()
        systems()
    if A.stage in ("devices", "all"):
        devices()
