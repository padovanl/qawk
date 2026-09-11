#!/usr/bin/env python3
"""Does Qawk answer the way hawkBit 1.1.0 answers?

    python3 ota/qawk/test/contract.py [http://localhost:18080]

Runs, against the server under test, the same flow that was recorded against
a real hawkBit 1.1.0 (reference/samples, see capture.py in the history of this
directory): a device registering, being given a set, reading it, downloading
ranges, reporting, being told to cancel, and the operator's side of the same
story. Each answer is compared with the recorded one:

  - the status code must be the same;
  - every field hawkBit sends must be there, with the same JSON type
    (a field Qawk adds on top is reported, not failed);
  - the values that are vocabulary rather than data must be equal: link
    names, statuses, the history messages the console reads, the error codes,
    "download"/"update", a chunk's part;
  - the download headers a resuming or delta download relies on must match.

Ids, timestamps and host names differ by nature and are not compared.
Standard library only, so it runs anywhere python3 does.
"""
import base64
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://localhost:18080").rstrip("/")
USER, PASS = os.environ.get("QAWK_USER", "admin"), os.environ.get("QAWK_PASSWORD", "changeme")
TENANT = "DEFAULT"
HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "..", "reference", "samples")
AUTH = "Basic " + base64.b64encode(f"{USER}:{PASS}".encode()).decode()
TOKEN = (os.environ.get("QAWK_CONTRACT_TOKEN") or os.environ.get("QAWK_GATEWAY_TOKEN")
         or ("qawk-contract-" + uuid.uuid4().hex[:8]))
RUN = uuid.uuid4().hex[:6]           # names are unique per run
PROBE = "contract-probe-" + RUN

passed = failed = warned = 0

# Where Qawk differs from hawkBit on purpose. Anything here is in the README.
DEVIATIONS = {
    ("mgmt-rollout-create", "body.status"):
        "Qawk creates the groups at once, so a new rollout is ready; hawkBit answers 'creating' and fills "
        "them in the background. A client written for hawkBit waits for 'ready', and gets it straight away.",
}


def call(method, path, body=None, ddi=False, headers=None, raw=False, multipart=None):
    h = {"Authorization": ("GatewayToken " + TOKEN) if ddi else AUTH}
    data = None
    if body is not None:
        h["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    if multipart is not None:
        name, content = multipart
        boundary = "qawk" + uuid.uuid4().hex
        h["Content-Type"] = "multipart/form-data; boundary=" + boundary
        data = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
                f"Content-Type: application/octet-stream\r\n\r\n").encode() + content + f"\r\n--{boundary}--\r\n".encode()
    h.update(headers or {})
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=h)
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        code = resp.status
    except urllib.error.HTTPError as e:
        resp, code = e, e.code
    payload = resp.read()
    hd = {k.lower(): v for k, v in resp.headers.items()}
    if raw:
        return code, hd, payload
    try:
        js = json.loads(payload) if payload else None
    except ValueError:
        js = payload.decode(errors="replace")
    return code, hd, js


def sample(name):
    with open(os.path.join(SAMPLES, name + ".json")) as f:
        return json.load(f)


# Values compared exactly, wherever they appear: vocabulary, not data.
EXACT_KEYS = {"type", "status", "forceType", "updateStatus", "download", "update", "part", "errorCode",
              "exceptionClass", "execution", "finished", "key", "requestAttributes", "active", "complete",
              "valid", "deleted", "locked", "encrypted"}
# Values that are per-run by nature.
SKIP_KEYS = {"id", "controllerId", "createdAt", "lastModifiedAt", "createdBy", "lastModifiedBy", "securityToken",
             "timestamp", "reportedAt", "lastRequestAt", "nextExpectedRequestAt", "lastControllerRequestAt",
             "installedAt", "address", "ipAddress", "name", "description", "stopId", "size", "sha1", "md5",
             "sha256", "filename", "providedFilename", "version", "message", "info", "entityId", "path",
             "distributionSetId", "totalTargets", "overdue", "weight", "value", "query", "targetFilterQuery"}


def compare(want, got, where, problems, notes, values=True):
    if isinstance(want, dict):
        if not isinstance(got, dict):
            problems.append(f"{where}: expected an object, got {type(got).__name__}")
            return
        for k, v in want.items():
            if k not in got:
                problems.append(f"{where}.{k}: missing")
                continue
            if k == "_links":
                missing = set(v) - set(got[k] or {})
                if missing:
                    problems.append(f"{where}._links: missing {sorted(missing)}")
                continue
            if k == "messages" and isinstance(v, list) and values:
                # the server's own words must match; the device's are its own
                for m in v:
                    if isinstance(m, str) and (m.startswith("Update Server:") or m.startswith("Assignment")):
                        if not any(isinstance(g, str) and _same_message(m, g) for g in (got[k] or [])):
                            problems.append(f"{where}.messages: hawkBit wrote {m!r}, missing here: {got[k]}")
                continue
            if k in SKIP_KEYS:
                if v is not None and got[k] is not None and type(v) is not type(got[k]) \
                        and not (isinstance(v, (int, float)) and isinstance(got[k], (int, float))):
                    problems.append(f"{where}.{k}: {type(v).__name__} in hawkBit, {type(got[k]).__name__} here")
                continue
            if k in EXACT_KEYS and not isinstance(v, (dict, list)) and values:
                if v != got[k]:
                    problems.append(f"{where}.{k}: hawkBit {v!r}, here {got[k]!r}")
                continue
            if k in EXACT_KEYS and not isinstance(v, (dict, list)):
                continue
            compare(v, got[k], f"{where}.{k}", problems, notes, values)
        extra = set(got) - set(want)
        if extra:
            notes.append(f"{where}: also has {sorted(extra)}")
    elif isinstance(want, list):
        if not isinstance(got, list):
            problems.append(f"{where}: expected a list, got {type(got).__name__}")
        elif want and got:
            compare(want[0], got[0], where + "[0]", problems, notes, values)
        elif want and not got:
            problems.append(f"{where}: hawkBit had items, here the list is empty")
    else:
        if want is not None and got is not None and type(want) is not type(got) \
                and not (isinstance(want, (int, float)) and isinstance(got, (int, float))):
            problems.append(f"{where}: {type(want).__name__} in hawkBit, {type(got).__name__} here")


def _same_message(a, b):
    # hawkBit's messages carry paths and names from its run; compare the wording
    return a.split(" /")[0].split("'")[0] == b.split(" /")[0].split("'")[0]


def check(name, got_code, got_body, sample_name=None, got_headers=None, header_keys=(), values=True, raw=False):
    global passed, failed, warned
    s = sample(sample_name or name)
    problems, notes = [], []
    if got_code != s["status"]:
        problems.append(f"status: hawkBit {s['status']}, here {got_code}")
    if raw:
        pass  # a file or a checksum: the headers and the bytes are checked instead
    elif s.get("body") is not None and got_body is not None:
        compare(s["body"], got_body, "body", problems, notes, values)
    elif s.get("body") is not None and got_body is None:
        problems.append("body: hawkBit sent one, here none")
    for hk in header_keys:
        want = (s.get("headers") or {}).get(hk)
        got = (got_headers or {}).get(hk)
        if want is not None and got is None:
            problems.append(f"header {hk}: missing")
        elif hk in ("accept-ranges", "content-type") and want != got:
            problems.append(f"header {hk}: hawkBit {want!r}, here {got!r}")
    for p in list(problems):
        why = DEVIATIONS.get((name, p.split(':')[0]))
        if why:
            problems.remove(p)
            notes.append(f"deliberate: {p} -- {why}")
    if problems:
        failed += 1
        print(f"  FAIL {name}")
        for p in problems[:12]:
            print(f"         {p}")
    else:
        passed += 1
        print(f"  ok   {name}")
    for n in notes[:3]:
        warned += 1
        print(f"         note: {n}")


def must(code, body, what):
    if code >= 300:
        print(f"  setup failed at {what}: {code} {body}")
        sys.exit(2)
    return body


print(f"  server under test: {BASE}\n")

# ---- setup: a gateway token, two modules with one artifact each, two sets -----
must(*call("PUT", "/rest/v1/system/configs/authentication.gatewaytoken.key", {"value": TOKEN})[::2], "token")
sets = []
for ver in ("1.1.0", "1.2.0"):
    code, _, sm = call("POST", "/rest/v1/softwaremodules",
                       [{"name": "hello-" + RUN, "version": ver, "type": "application", "vendor": "QubicaAMF",
                         "description": "contract test"}])
    sm = must(code, sm, "module")[0]
    content = (f"contract artifact {ver} {RUN}\n".encode()) * 1024
    code, _, art = call("POST", f"/rest/v1/softwaremodules/{sm['id']}/artifacts",
                        multipart=(f"hello-{ver}.swu", content))
    must(code, art, "upload")
    if art["hashes"]["sha1"] != hashlib.sha1(content).hexdigest():
        print("  FAIL upload: the stored SHA1 is not the file's")
        failed += 1
    code, _, ds = call("POST", "/rest/v1/distributionsets",
                       [{"name": "app-" + RUN, "version": ver, "type": "app", "description": "contract test",
                         "modules": [{"id": sm["id"]}]}])
    sets.append((must(code, ds, "set")[0], sm, content))
(ds1, sm1, content1), (ds2, sm2, _) = sets

# ---- the DDI flow ------------------------------------------------------------
P = PROBE
c, h, b = call("GET", f"/{TENANT}/controller/v1/{P}", ddi=True)
check("ddi-base-first-poll", c, b)
c, h, b = call("PUT", f"/{TENANT}/controller/v1/{P}/configData", {"mode": "merge", "data": {"device_type": "probe", "slot": "A"}}, ddi=True)
check("ddi-configdata-put", c, b)
c, h, b = call("POST", f"/rest/v1/distributionsets/{ds1['id']}/assignedTargets", [{"id": P, "type": "soft"}])
check("mgmt-assign", c, b)
c, h, base = call("GET", f"/{TENANT}/controller/v1/{P}", ddi=True)
check("ddi-base-with-deployment", c, base)
href = base["_links"]["deploymentBase"]["href"]
dpath = href[href.index(f"/{TENANT}/"):]
c, h, dep = call("GET", dpath, ddi=True)
check("ddi-deploymentbase", c, dep)
art = dep["deployment"]["chunks"][0]["artifacts"][0]
dl = art["_links"]["download-http"]["href"]
dlp = dl[dl.index(f"/{TENANT}/"):]
c, h, data = call("GET", dlp, ddi=True, headers={"Range": "bytes=0-99"}, raw=True)
check("ddi-download-range", c, None, raw=True, got_headers=h,
      header_keys=("content-range", "accept-ranges", "content-type", "content-disposition", "etag", "last-modified"))
if data != content1[:100]:
    failed += 1
    print("  FAIL ddi-download-range: the bytes are not the artifact's first 100")
c, h, _ = call("HEAD", dlp, ddi=True, raw=True)
check("ddi-download-head", c, None, raw=True, got_headers=h, header_keys=("accept-ranges", "content-type", "content-length", "etag"))
c, h, data = call("GET", dlp + ".MD5SUM", ddi=True, raw=True)
check("ddi-download-md5sum", c, None, raw=True, got_headers=h, header_keys=("content-type", "content-disposition"))
if data.decode().split()[0] != hashlib.md5(content1).hexdigest():
    failed += 1
    print("  FAIL ddi-download-md5sum: not the artifact's MD5")
aid = dep["id"]
c, h, b = call("POST", f"/{TENANT}/controller/v1/{P}/deploymentBase/{aid}/feedback",
               {"status": {"execution": "proceeding", "result": {"finished": "none", "progress": {"of": 1, "cnt": 0}},
                           "details": ["Installing Update Chunk Artifacts."]}}, ddi=True)
check("ddi-feedback-proceeding", c, b)
c, h, b = call("GET", f"/rest/v1/targets/{P}/actions/{aid}/status?sort=id:DESC")
check("mgmt-action-status-after-feedback", c, b)
c, h, b = call("POST", f"/rest/v1/distributionsets/{ds2['id']}/assignedTargets", [{"id": P, "type": "forced"}])
check("mgmt-assign-second", c, b)
c, h, base2 = call("GET", f"/{TENANT}/controller/v1/{P}", ddi=True)
check("ddi-base-with-cancel", c, base2)
ch = base2["_links"]["cancelAction"]["href"]
cp = ch[ch.index(f"/{TENANT}/"):]
c, h, b = call("GET", cp, ddi=True)
check("ddi-cancelaction", c, b)
c, h, b = call("POST", f"{cp}/feedback", {"status": {"execution": "closed", "result": {"finished": "success"}, "details": ["cancelled"]}}, ddi=True)
check("ddi-cancel-feedback", c, b)
c, h, base3 = call("GET", f"/{TENANT}/controller/v1/{P}", ddi=True)
check("ddi-base-after-cancel", c, base3)
h3 = base3["_links"]["deploymentBase"]["href"]
c, h, d3 = call("GET", h3[h3.index(f"/{TENANT}/"):], ddi=True)
check("ddi-deploymentbase-forced", c, d3)
c, h, b = call("POST", f"/{TENANT}/controller/v1/{P}/deploymentBase/{d3['id']}/feedback",
               {"status": {"execution": "closed", "result": {"finished": "success"}, "details": ["done"]}}, ddi=True)
check("ddi-feedback-closed-success", c, b)
c, h, b4 = call("GET", f"/{TENANT}/controller/v1/{P}", ddi=True)
check("ddi-base-after-success", c, b4)
hi = b4["_links"]["installedBase"]["href"]
c, h, b = call("GET", hi[hi.index(f"/{TENANT}/"):], ddi=True)
check("ddi-installedbase", c, b)
c, h, b = call("POST", f"/{TENANT}/controller/v1/{P}/deploymentBase/999999/feedback",
               {"status": {"execution": "closed", "result": {"finished": "success"}}}, ddi=True)
check("ddi-feedback-unknown-action", c, b)
c, h, b = call("GET", f"/{TENANT}/controller/v1/{P}", headers={"Authorization": "GatewayToken wrong"})
check("ddi-bad-token", c, b)

# ---- the operator's side ------------------------------------------------------
c, h, b = call("GET", f"/rest/v1/targets/{P}")
check("mgmt-target", c, b, "mgmt-probe-target", values=False)
c, h, b = call("GET", f"/rest/v1/targets/{P}/actions?limit=3&sort=id:DESC")
check("mgmt-target-actions", c, b)
c, h, b = call("GET", f"/rest/v1/targets/{P}/actions/{aid}")
check("mgmt-target-action", c, b, values=False)
c, h, b = call("GET", f"/rest/v1/targets/{P}/attributes")
if c == 200 and b == {"device_type": "probe", "slot": "A"}:
    passed += 1
    print("  ok   mgmt-target-attributes (the configData this probe sent)")
else:
    failed += 1
    print(f"  FAIL mgmt-target-attributes: {c} {b}")
c, h, b = call("GET", f"/rest/v1/targets/{P}/autoConfirm")
check("mgmt-target-autoConfirm", c, b)
c, h, b = call("GET", f"/rest/v1/targets/{P}/installedDS")
check("mgmt-target-installedDS", c, b, values=False)
c, h, b = call("GET", "/rest/v1/actions?limit=2&sort=id:DESC")
check("mgmt-actions-list", c, b)
c, h, b = call("GET", f"/rest/v1/distributionsets/{ds1['id']}")
check("mgmt-ds", c, b, values=False)
c, h, b = call("GET", "/rest/v1/distributionsets?limit=2")
check("mgmt-ds-list", c, b, values=False)
c, h, b = call("GET", f"/rest/v1/distributionsets/{ds1['id']}/assignedSM")
check("mgmt-ds-assignedSM", c, b, values=False)
c, h, b = call("GET", f"/rest/v1/softwaremodules/{sm1['id']}")
check("mgmt-sm", c, b, values=False)
c, h, arts = call("GET", f"/rest/v1/softwaremodules/{sm1['id']}/artifacts")
check("mgmt-sm-artifacts", c, arts)
c, h, b = call("GET", f"/rest/v1/softwaremodules/{sm1['id']}/artifacts/{arts[0]['id']}")
check("mgmt-sm-artifact", c, b)
for p in ("softwaremoduletypes", "distributionsettypes"):
    c, h, b = call("GET", f"/rest/v1/{p}")
    check("mgmt-" + p, c, b)
    c, h, b = call("GET", f"/rest/v1/{p}/1")
    check("mgmt-" + p + "-one", c, b)
c, h, b = call("GET", "/rest/v1/system/configs")
check("mgmt-system-configs", c, b)

# hawkBit's clients write FIQL's ";" unescaped (our upload script does); the
# filter must survive it, or the request quietly returns everything.
c, h, b = call("GET", f"/rest/v1/softwaremodules?q=name==hello-{RUN};version==1.2.0")
if c == 200 and b["total"] == 1 and b["content"][0]["version"] == "1.2.0":
    passed += 1
    print("  ok   an unescaped ';' in q= still filters")
else:
    failed += 1
    print(f"  FAIL an unescaped ';' in q=: {c} total={b.get('total') if isinstance(b, dict) else b}")

c, h, b = call("GET", "/rest/v1/targets/does-not-exist")
check("err-target-404", c, b)
c, h, b = call("GET", "/rest/v1/targets?q=nonesuch==x")
check("err-fiql-field", c, b)
c, h, b = call("GET", "/rest/v1/targets?q=name==")
check("err-fiql-syntax", c, b)
c, h, b = call("GET", "/rest/v1/targets", headers={"Authorization": "Basic eDp5"})
check("err-unauthorized", c, b)

c, h, b = call("POST", "/rest/v1/targetfilters", {"name": "contract-filter-" + RUN, "query": f"controllerId=={P}"})
check("mgmt-targetfilter-create", c, b)
c, h, tg = call("POST", "/rest/v1/targettags", [{"name": "contract-tag-" + RUN, "colour": "#ff0000", "description": "probe"}])
check("mgmt-targettag-create", c, tg)
c, h, b = call("POST", f"/rest/v1/targettags/{tg[0]['id']}/assigned", [P])
if c >= 300:
    failed += 1
    print(f"  FAIL tag assignment with the console's body: {c} {b}")
else:
    passed += 1
    print("  ok   tag assignment with the console's body")
c, h, ro = call("POST", "/rest/v1/rollouts", {"name": "contract-rollout-" + RUN, "distributionSetId": ds1["id"],
                "targetFilterQuery": f"controllerId=={P}", "amountGroups": 1,
                "successCondition": {"condition": "THRESHOLD", "expression": "100"},
                "errorCondition": {"condition": "THRESHOLD", "expression": "50"}})
check("mgmt-rollout-create", c, ro)
# A hawkBit client waits for a rollout to leave 'creating' before using it:
# hawkBit fills the groups in the background. (Qawk is ready at once.)
for _ in range(30):
    if call("GET", f"/rest/v1/rollouts/{ro['id']}")[2].get("status") != "creating":
        break
    time.sleep(1)
c, h, g = call("GET", f"/rest/v1/rollouts/{ro['id']}/deploygroups")
check("mgmt-rollout-groups", c, g, values=False)
c, h, b = call("GET", f"/rest/v1/rollouts/{ro['id']}/deploygroups/{g['content'][0]['id']}")
check("mgmt-rollout-group", c, b, values=False)
c, h, b = call("GET", f"/rest/v1/rollouts/{ro['id']}/deploygroups/{g['content'][0]['id']}/targets")
check("mgmt-rollout-group-targets", c, b)
c, h, b = call("POST", f"/rest/v1/rollouts/{ro['id']}/start")
check("mgmt-rollout-start", c, b)
# and hawkBit goes through 'starting' in the background too
for _ in range(30):
    if call("GET", f"/rest/v1/rollouts/{ro['id']}")[2].get("status") not in ("creating", "ready", "starting"):
        break
    time.sleep(1)
c, h, b = call("GET", f"/rest/v1/rollouts/{ro['id']}")
check("mgmt-rollout-running", c, b)

print(f"\n  {passed} ok, {failed} failed, {warned} notes")
sys.exit(1 if failed else 0)
