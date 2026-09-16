# Using Qawk

Every feature, step by step: in the console and with the API. Everything here
can be tried on the demo (`demo/start.sh`) with simulated devices
(`demo/simulate.sh`); the commands below were run against it.

The API examples use two shell variables:

```bash
Q=http://localhost:8080
A='-u admin:changeme'          # or: -H "Authorization: Bearer qawk_…"
```

Qawk speaks **hawkBit's Management API** under `/rest/v1` (targets, modules,
sets, rollouts…) and adds its own under `/qawk/v1` (channels, releases,
systems, centres, users…). hawkBit's
[API documentation](https://eclipse.dev/hawkbit/apis/management_api/) applies
to the first as it is.

1. [The words](#1-the-words)
2. [Devices](#2-devices)
3. [Software: modules and distribution sets](#3-software-modules-and-distribution-sets)
4. [Deploying to devices](#4-deploying-to-devices)
5. [Rollouts](#5-rollouts)
6. [Channels](#6-channels)
7. [The release pipeline: gates, approvals, promotion](#7-the-release-pipeline-gates-approvals-promotion)
8. [When a release goes wrong: halts, rollback, freezes](#8-when-a-release-goes-wrong-halts-rollback-freezes)
9. [Temporary channels: devices lent and sent home](#9-temporary-channels-devices-lent-and-sent-home)
10. [Centres](#10-centres)
11. [The orchestrator: systems updated as a whole](#11-the-orchestrator-systems-updated-as-a-whole)
12. [Users, roles, API tokens and the audit log](#12-users-roles-api-tokens-and-the-audit-log)
13. [Watching it run](#13-watching-it-run)
14. [Trying all of this with simulated devices](#14-trying-all-of-this-with-simulated-devices)

---

## 1. The words

| | |
|---|---|
| **target** (device) | something that polls Qawk for updates, known by its controller id |
| **attributes** | what a device reports about itself (`device_type`, `os_version`, `ring`, `centerid`…); every query can use them as `attribute.<name>` |
| **software module** | one piece of software with its files (artifacts): an `os` image, an `application` package |
| **distribution set** | what is deployed: one or more modules under a name and version (`app 1.2.0`) |
| **action** | one deployment to one device, from assigned to finished or failed |
| **rollout** | hawkBit's staged deployment: a query of devices split into groups |
| **channel** (fleet) | a set of devices that should run the same release: dev, beta, prod |
| **release** | a distribution set given to a channel, directly or by promotion |
| **centre** | where a device is; a centre is put in a channel and its devices follow |
| **system type**, **system** | devices that only work together (a device1 with two device2 and a device3), updated as one |
| **manifest** | what each component of a system should run, and in which order |

Queries everywhere use hawkBit's FIQL: `attribute.device_type==device2`,
`controllerId==shop-*`, `name==app;version==1.2.0` (`;` is AND, `,` is OR).
Qawk adds `fleet==beta`.

---

## 2. Devices

### Letting devices register

A device registers itself at its first poll when it presents the **gateway
token**. Console: **Configuration** → tenant configuration, *gateway token*.
API:

```bash
curl $A -X PUT -H 'Content-Type: application/json' -d '{"value": true}' \
  $Q/rest/v1/system/configs/authentication.gatewaytoken.enabled
curl $A -X PUT -H 'Content-Type: application/json' -d '{"value": "a-random-token"}' \
  $Q/rest/v1/system/configs/authentication.gatewaytoken.key
```

The polling interval is `pollingTime` in the same place (`00:05:00` by
default; `QAWK_POLLING_TIME` sets it for a new server).

### Finding them

**Targets** lists every device, paged by the server: the status buttons on
top (up to date, updating, failed, never updated), a channel filter, and a
query field with completion. **columns** chooses what is shown — any
attribute a device reports becomes a column; **export** saves the table as
CSV; **save filter** keeps the query. A row opens the device: attributes,
metadata, tags, what is assigned and installed, and every action with the
messages the device sent.

```bash
curl $A "$Q/rest/v1/targets?q=attribute.device_type==device2&limit=50"
curl $A "$Q/rest/v1/targets/shop-prod-017/attributes"
curl $A "$Q/rest/v1/targets/shop-prod-017/actions?sort=id:DESC&limit=5"
```

**Tags** and **metadata** are hawkBit's and are set from the device's panel or
`/rest/v1/targets/{id}/metadata`. Metadata is how you tell Qawk something the
device does not report — which system it belongs to, for example
(`metadata.system`).

---

## 3. Software: modules and distribution sets

**Modules** → **new module** (a name, a version, a type: `os` or
`application`), then open it and upload its files. **Distribution sets** →
**new set**, pick its modules. The console checks an upload before sending
it: a signed package, a delta with its index file, a pair from the same
build.

```bash
# a module and its artifact
M=$(curl -s $A -H 'Content-Type: application/json' \
  -d '[{"name":"app","version":"1.2.0","type":"application"}]' \
  $Q/rest/v1/softwaremodules | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["id"])')
curl $A -F file=@app-1.2.0.swu $Q/rest/v1/softwaremodules/$M/artifacts

# a set with it
curl $A -H 'Content-Type: application/json' \
  -d "[{\"name\":\"app\",\"version\":\"1.2.0\",\"type\":\"app\",\"modules\":[{\"id\":$M}]}]" \
  $Q/rest/v1/distributionsets
```

Unlike hawkBit, a deleted module or set frees its name and version: you can
upload the same pair again.

---

## 4. Deploying to devices

### One device, or many

Console: **Targets** → **deploy to…**, or the **deploy** button of a set. The
dialog asks what (a set) and to whom — *this device*, *a device type*,
*every device*, or a query — shows how many devices match, and how:

| action type | the device… |
|---|---|
| `forced` | installs at once |
| `soft` | is offered it and may wait (SWUpdate installs it too) |
| `timeforced` | soft until a time, forced after |
| `downloadonly` | downloads and reports `downloaded`, installs nothing |

```bash
# one device: a single object
curl $A -H 'Content-Type: application/json' -d "{\"id\": $SET, \"type\": \"forced\"}" \
  $Q/rest/v1/targets/shop-prod-017/assignedDS

# many devices: a list
curl $A -H 'Content-Type: application/json' \
  -d '[{"id":"shop-prod-017","type":"forced"},{"id":"shop-prod-018","type":"forced"}]' \
  $Q/rest/v1/distributionsets/$SET/assignedTargets
```

The device's status goes `pending` → `in_sync`; its action ends `finished`
or `error`. Assigning something else while an action is open cancels the open
one first (the device confirms the cancellation), as in hawkBit.

### A maintenance window

Install only in a window: the device downloads at once, and installs when the
window opens.

```bash
curl $A -H 'Content-Type: application/json' -d "{
  \"id\": $SET, \"type\": \"forced\",
  \"maintenanceWindow\": {\"schedule\": \"0 0 3 * * ?\", \"duration\": \"00:30:00\", \"timezone\": \"+01:00\"}
}" $Q/rest/v1/targets/shop-prod-017/assignedDS
```

`schedule` is a Quartz cron (seconds first: `0 0 3 * * ?` is 03:00 every day),
`duration` how long the window stays open, `timezone` the offset the cron is
read in. Until then the action is `scheduled` and carries `nextStartAt`. A
window that is half given, unreadable or never comes again is refused.

### Cancelling

From the device's panel (**cancel**, or **force cancel** for a device that
will never answer), or:

```bash
curl $A -X DELETE $Q/rest/v1/targets/shop-prod-017/actions/$ACTION          # cancel
curl $A -X DELETE "$Q/rest/v1/targets/shop-prod-017/actions/$ACTION?force=true"
```

### Rolling a device back

Qawk rolls back by deploying what ran before: assign the previous set to the
device. (A device that fails an update keeps the version it had — SWUpdate's
A/B update does that on the device — and the action ends `error`.) For
channels and systems, see [§8](#8-when-a-release-goes-wrong-halts-rollback-freezes)
and [§11](#11-the-orchestrator-systems-updated-as-a-whole).

---

## 5. Rollouts

A rollout deploys a set to the devices a query matches, **group by group**:
the next group when enough of the last succeeded, a pause when too many
failed.

Console: **Rollouts** → **new rollout** (or **roll out this filter** from
Targets): name, set, target filter, group count, action type, start type
(*manual*, *auto*, *scheduled* at a time), success threshold, error
threshold. Then **start**, **pause**, **resume**, **approve** / **deny** (when
rollout approval is on), and **trigger next group** without waiting.

```bash
R=$(curl -s $A -H 'Content-Type: application/json' -d "{
  \"name\": \"app 1.2.0 to the shops\", \"distributionSetId\": $SET,
  \"targetFilterQuery\": \"controllerId==shop-*\", \"amountGroups\": 4, \"type\": \"forced\",
  \"successCondition\": {\"condition\": \"THRESHOLD\", \"expression\": \"80\"},
  \"successAction\":    {\"action\": \"NEXTGROUP\", \"expression\": \"\"},
  \"errorCondition\":   {\"condition\": \"THRESHOLD\", \"expression\": \"20\"},
  \"errorAction\":      {\"action\": \"PAUSE\", \"expression\": \"\"}
}" $Q/rest/v1/rollouts | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

curl $A -X POST $Q/rest/v1/rollouts/$R/start
curl $A -X POST $Q/rest/v1/rollouts/$R/pause
curl $A -X POST $Q/rest/v1/rollouts/$R/resume
curl $A -X POST $Q/rest/v1/rollouts/$R/triggerNextGroup
curl $A "$Q/rest/v1/rollouts/$R/deploygroups"
```

`"startAt": <epoch ms>` starts it by itself at that time. A new rollout is
`ready` at once: Qawk creates its groups in the same request. `fleet==beta`
as the query rolls out over a channel.

Rollouts are the tool for a one-off campaign over any query. For releases
that move through environments every time, use channels.

---

## 6. Channels

A **channel** (a *fleet* in the API) is a set of devices that should run the
same release. A device is in at most one.

### Creating one

Console: **Fleets** → **new fleet**:

| field | |
|---|---|
| Name, Description, Colour | |
| **Rule** | a query: devices **in no channel** that match join this one, now and whenever they register (`attribute.ring==beta`). Empty: nobody joins by rule |
| **Takes releases from** | the upstream channel (see [§7](#7-the-release-pipeline-gates-approvals-promotion)); *none*: releases are given directly |
| **Promotion from it** | *by hand* or *by itself, as soon as the gate opens* |
| **temporary** | devices come back to the channel they came from (§9) |
| **Gate** | devices on it, % of the channel, soak minutes, a second person approves |
| **Delivery** | wave % (0: all at once), next wave after N minutes, halt over N % failed, mode forced / soft |
| **Orchestrator** | systems at a time, systems that may fail, one centre at a time (§11) |

```bash
curl $A -H 'Content-Type: application/json' -d '{
  "name": "dev", "colour": "#3e9b4f", "description": "the lab",
  "rule": "attribute.ring==dev"
}' $Q/qawk/v1/fleets
```

### Members

By rule, or by hand: **manage** → **add** in the console, or

```bash
curl $A -X PUT    -H 'Content-Type: application/json' -d '["shop-prod-017","shop-prod-018"]' $Q/qawk/v1/fleets/$DEV/targets
curl $A -X DELETE -H 'Content-Type: application/json' -d '["shop-prod-018"]' $Q/qawk/v1/fleets/$DEV/targets
```

A rule never moves a device that is already in a channel; move it by hand.
**devices** opens the members in Targets (`fleet==dev`).

### Giving a channel a release

Only a channel with **no upstream** is given a release directly (the others
are promoted into). Console: **release** on its card; API:

```bash
curl $A -X PUT -H 'Content-Type: application/json' -d "{\"distributionSetId\": $SET}" $Q/qawk/v1/fleets/$DEV
```

Every member gets it, in waves if the channel has them, and so does any device
that joins later. The card shows the release, a bar of the devices on it, the
wave, and whether it is `active`, `completed` or `halted`. **history** lists
every release of the channel: when, what, from where, status, who asked, who
decided, how many waves.

---

## 7. The release pipeline: gates, approvals, promotion

Channels chain: `beta` takes releases from `dev`, `prod` from `beta`. A
channel with an upstream only takes what its upstream runs, **by
promotion**, and only through its **gate**:

| gate | the release must… |
|---|---|
| devices on it | run on at least N devices of the upstream |
| % of the fleet | run on at least N % of the upstream |
| soak, minutes | have been in the upstream for N minutes |
| a second person approves | be approved by someone other than who asked |

A halted release never passes.

```bash
curl $A -X PUT -H 'Content-Type: application/json' -d "{
  \"upstreamId\": $DEV, \"wavePercent\": 25, \"errorThreshold\": 10,
  \"gate\": {\"minDevices\": 10, \"minSuccess\": 90, \"soakMinutes\": 60}
}" $Q/qawk/v1/fleets/$BETA
```

### Promoting

Console: **promote from dev** on beta's card. The dialog shows the gate's
report line by line before anything is sent:

```
✓ app:1.1.0 in dev is not halted
✓ 20 devices of dev run app:1.1.0 (at least 10)
✓ 100% of dev runs it (at least 90%)
✓ it has been in dev for 25 minutes (at least 0)
It goes out 25% of the fleet at a time; it halts if more than 10% fail.
```

```bash
curl $A "$Q/qawk/v1/fleets/$BETA/gate?from=$DEV"                 # would it open, and why
curl $A -H 'Content-Type: application/json' -d "{\"from\": $DEV}" $Q/qawk/v1/fleets/$BETA/promote
```

| answer | |
|---|---|
| `200` | promoted: the release starts in beta |
| `202` | waiting for approval |
| `409` | the gate is closed (the report says why), or the channel is frozen |
| `400` | not its upstream, or a force without a reason |

### Four eyes

With *a second person approves* on, a promotion answers `202` and waits in the
queue at the top of **Fleets** (**Waiting for approval**) until someone with
the `APPROVE_ROLLOUT` permission **who did not ask** approves or denies it.
Whoever asked cannot approve their own (`403`).

```bash
curl $A "$Q/qawk/v1/releases?status=waiting_for_approval"
curl -u rm-2:… -H 'Content-Type: application/json' -d '{"note": "looks good"}' $Q/qawk/v1/releases/$REL/approve
curl -u rm-2:… -H 'Content-Type: application/json' -d '{"note": "not before the weekend"}' $Q/qawk/v1/releases/$REL/deny
```

A denial stays in the channel's history with who denied it and the note.

### Forcing a closed gate

Someone with `APPROVE_ROLLOUT` (the `release-manager` role) may promote
through a closed gate, **only with a reason**, which stays in the history:

```bash
curl -u rm-1:… -H 'Content-Type: application/json' \
  -d "{\"from\": $DEV, \"force\": true, \"reason\": \"hotfix, signed off by QA\"}" \
  $Q/qawk/v1/fleets/$BETA/promote
```

### Promotion by itself

Set a channel to promote itself (*Promotion from it: by itself*, or
`"autoPromote": true`): as soon as its gate opens for a new release of the
upstream, the engine promotes it as user `system`, through the same gate and
approval. It asks once per release.

```bash
curl $A -X PUT -H 'Content-Type: application/json' -d '{"autoPromote": true}' $Q/qawk/v1/fleets/$BETA
```

---

## 8. When a release goes wrong: halts, rollback, freezes

### A release halts by itself

Inside a channel a release goes out in waves. When the devices that failed pass
the channel's *halt over %* of those that finished, the release **halts**:
nothing more is sent, and every gate downstream closes (*✗ … is not halted*).
The card turns red; `qawk_fleet_releases_halted` counts it.

Try it on the demo: give `dev` the set `app-broken 1.3.0` — the simulated
devices fail anything named *broken*.

### Going on, or going back

- **Going back** is giving the channel the good release again: **release** →
  the previous set (API: `PUT /qawk/v1/fleets/{id}` with its
  `distributionSetId`). The new release supersedes the halted one, and the
  devices that took the bad one are sent the good one.
- **Going on** after deciding the failures do not matter: **resume** on the
  card, or

  ```bash
  curl $A -X POST $Q/qawk/v1/fleets/$DEV/resume
  ```

  Only new failures count after a resume.

Systems roll back on their own when one of their devices fails; see §11.

### Freezing a channel

A freeze stops every release reaching the channel — promotions, direct
releases, delivery — for a venue opening, a holiday, an audit. Console:
**freeze** (a reason, from, until; empty: now and until thawed). API:

```bash
curl $A -X PUT -H 'Content-Type: application/json' -d '{"reason": "venue opening"}' $Q/qawk/v1/fleets/$BETA/freeze
curl $A -X PUT -H 'Content-Type: application/json' \
  -d '{"reason": "christmas", "from": 1798761600000, "until": 1799366400000}' $Q/qawk/v1/fleets/$BETA/freeze
curl $A -X DELETE $Q/qawk/v1/fleets/$BETA/freeze                          # thaw
```

`from` and `until` are epoch milliseconds. A promotion into a frozen channel
answers `409` with the reason. Someone can still assign one device by hand;
the audit log records who.

---

## 9. Temporary channels: devices lent and sent home

A **temporary** channel — `expo`, the machines taken to a trade show —
remembers where each device came from. Lend devices to it by adding them
(they leave their channel), give it whatever release the show needs, and send
them home afterwards: back in their channel, they get its release again.

```bash
curl $A -X PUT -H 'Content-Type: application/json' -d '["shop-prod-017","shop-prod-018"]' $Q/qawk/v1/fleets/$EXPO/targets
curl $A "$Q/qawk/v1/fleets/$EXPO/targets"                                  # each with its "home"
curl $A -H 'Content-Type: application/json' -d '{"controllerIds": ["shop-prod-017"]}' $Q/qawk/v1/fleets/$EXPO/return
curl $A -X POST $Q/qawk/v1/fleets/$EXPO/return                              # everyone home
```

Console: **manage** → **add** on expo's card, then **send devices home**.

---

## 10. Centres

A device says which centre it is in — `attribute.centerid` by default. A
**centre is put in a channel**, and every device of it follows: moving centre
`c03` from beta to prod moves all its devices, and they get what prod gets.

Console: **Centres** — every centre, its channel and devices, filtered by
channel; tick centres and **move**. **centre field** changes where the centre
is read from.

```bash
curl $A $Q/qawk/v1/centres
curl $A -X PUT -H 'Content-Type: application/json' -d "{\"centres\": [\"c03\",\"c04\"], \"fleetId\": $PROD}" $Q/qawk/v1/centres
curl $A -X PUT -H 'Content-Type: application/json' -d '{"field": "metadata.site"}' $Q/qawk/v1/centres/settings
```

- Devices are moved within seconds, a hundred at a time.
- A device of a centre cannot be moved by hand into another channel — its
  centre would take it back — but it can be **lent** to a temporary one.
- Devices with no centre keep the channel rules: by rule or by hand.

---

## 11. The orchestrator: systems updated as a whole

Some devices only work together: a device1 with two device2 and a device3
attached. Their components must be updated **in order** (the device2 and
device3 before the device1), and a system left half on the old version and
half on the new is worse than one not updated. Qawk follows
[Mender Orchestrator](https://docs.mender.io/orchestrate-updates/overview):
a **topology** says what a system is made of, a **manifest** what each
component runs and in which order — in Mender's own YAML — and the server
runs the orchestration. The devices speak plain hawkBit; nothing changes on
them.

### 1. The system type (topology)

Console: **Orchestrator** → **import YAML**, or **system type** to draw it:
name, how a device says which system it is in, the centre field, and each
component with the query that recognises its devices.

```yaml
api_version: mender/v1
kind: topology
system_type: device-system
qawk_system_key: attribute.device     # which system a device belongs to
components:
  - component_type: device1
    qawk_match: attribute.device_type==device1
  - component_type: device2
    qawk_match: attribute.device_type==device2
  - component_type: device3
    qawk_match: attribute.device_type==device3
```

```bash
curl $A -H 'Content-Type: application/yaml' --data-binary @topology.yaml $Q/qawk/v1/systemtypes/import
curl $A "$Q/qawk/v1/systemtypes/$TYPE/systems"          # the systems found, by centre and channel
```

Without `qawk_system_key` the key is `metadata.system` (set it on each device);
without `qawk_match` a component matches `attribute.device_type==<component_type>`.
Systems are **found** from the devices: nothing to register. **systems** on a
type lists them with their channel — *mixed channels* when their devices are
not all in one.

### 2. The manifest

```yaml
api_version: mender/v1
kind: manifest
name: device-system-2.0
system_types_compatible: [device-system]
component_types:
  device2: {artifact_name: "device2-fw:2.0", update_strategy: {order: 10}}
  device3: {artifact_name: "device3-fw:2.0", update_strategy: {order: 10}}
  device1: {artifact_name: "app:1.1.0",      update_strategy: {order: 20}}
```

`artifact_name` is a distribution set, `name:version`. Lower `order` first;
equal orders together. Import it the same way (**import YAML**, or
`POST /qawk/v1/manifests/import`), or draw it with **manifest**.
`GET /qawk/v1/manifests/{id}/manifest.yaml` gives it back.

### 3. Deploying a manifest

Console: **deploy a manifest**:

| field | |
|---|---|
| Manifest, Name | |
| **Channel** | only the systems whose devices are **all** in it |
| **Centres** | none ticked: every centre |
| every system in scope, **or these systems** | |
| **Systems at a time** | how many systems are updated together |
| **Systems that may fail** | past this, no new system is started and the deployment fails |

It is created as a **draft**: press **start** when ready. Then **pause**,
**resume**, **abort**.

```bash
D=$(curl -s $A -H 'Content-Type: application/json' -d "{
  \"name\": \"beta to 2.0\", \"manifestId\": $MANIFEST, \"fleetId\": $BETA,
  \"maxParallel\": 4, \"maxFailed\": 1, \"byCentre\": true
}" $Q/qawk/v1/systemdeployments | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

curl $A -X POST $Q/qawk/v1/systemdeployments/$D/start      # also: pause, resume, abort
curl $A $Q/qawk/v1/systemdeployments/$D                    # each system's run, each component's progress
```

`"groups": ["c03"]` limits it to some centres, `"systems": ["device-07"]` to
some systems, `"byCentre": true` takes one centre at a time (the next once
every system of the last is done).

Inside each system: order by order, a component already on its set is left
alone.

### 4. Rollback

**Automatic.** When one device of a system fails, **every device of that
system the deployment updated goes back** to the set it ran before — the
whole system, not the one device — and the other systems go on. The run ends
`rolled_back`.

**By hand.** A system that finished but must go back: **roll back** on its
run, or

```bash
curl $A -H 'Content-Type: application/json' -d '{"reason": "customer asked"}' \
  $Q/qawk/v1/systemdeployments/$D/runs/$RUN/rollback
```

Its components return to what they ran before the deployment, and the run
goes `rolling_back` → `rolled_back`.

### 5. Releases through the orchestrator

A channel's release is one set for every member, which a device1 and the
device2 under it cannot share. So a release can carry a **manifest** as well:
the set goes to the devices that stand alone, and the orchestrator takes the
channel's systems with the manifest. Console: **release** → *Distribution
set* and *Manifest*; how the systems are taken is in the channel's settings
(*Orchestrator*).

```bash
curl $A -X PUT -H 'Content-Type: application/json' \
  -d '{"orchestrator": {"maxParallel": 4, "maxFailed": 0, "byCentre": true}}' $Q/qawk/v1/fleets/$BETA
curl $A -X PUT -H 'Content-Type: application/json' \
  -d "{\"distributionSetId\": $SET, \"manifestId\": $MANIFEST}" $Q/qawk/v1/fleets/$DEV
```

- Promoted, the manifest comes along; `"orchestrator": false` in the
  promotion leaves it behind.
- The release is complete once the standalone devices run the set **and** the
  orchestrator has finished; the next gate checks both.
- More systems failing than the channel allows halts the release.
- A device that belongs to a system is updated by the orchestrator, never by
  its channel's set.

---

## 12. Users, roles, API tokens and the audit log

### Who can sign in

1. **The administrator** from the environment (`QAWK_ADMIN_USER` /
   `QAWK_ADMIN_PASSWORD`): every permission, never stored, always works.
2. **Users** in the database, each with roles. Console: **Users and roles** →
   **new user**. Or at startup from a file (`QAWK_USERS_FILE`, see the
   [README](../README.md#users)).
3. **API tokens**: **My account** → **new API token** (optionally expiring).
   Shown once. A token acts with its owner's permissions at the time of use.

```bash
curl $A -H 'Content-Type: application/json' \
  -d '{"username": "rm-1", "password": "at-least-8-chars", "roles": ["release-manager"], "displayName": "Release manager"}' \
  $Q/qawk/v1/users
curl -u rm-1:at-least-8-chars -H 'Content-Type: application/json' -d '{"name": "ci", "expiresInDays": 90}' $Q/qawk/v1/tokens
curl -H "Authorization: Bearer qawk_…" "$Q/rest/v1/targets?limit=1"
```

### Roles

| built-in | can |
|---|---|
| `admin` | everything, including users, roles and the audit log |
| `operator` | targets, channels, software, rollouts; deletes nothing, configures nothing, approves nothing |
| `release-manager` | an operator who also approves releases and forces a gate |
| `viewer` | reads everything, changes nothing |

**new role** makes others from hawkBit's permissions
(`GET /qawk/v1/permissions` lists them):

```bash
curl $A -H 'Content-Type: application/json' \
  -d '{"name": "auditor", "description": "reads, and the audit log", "permissions": ["READ_TARGET","READ_REPOSITORY","SYSTEM_ADMIN"]}' \
  $Q/qawk/v1/roles
```

A route someone may not use answers `403`.

### The audit log

Every request that changes something — who, how they signed in, method,
path, result, address — and every refused sign-in. Console: **Audit log**.
Filter like any list:

```bash
curl $A "$Q/qawk/v1/audit?q=user==rm-1;status=ge=400&limit=50"
```

Kept for `QAWK_AUDIT_DAYS` (180).

---

## 13. Watching it run

- **Dashboard**: channels and their releases, what needs attention, devices
  by update status, what is in progress.
- **In progress**: every open deployment — to devices, rollouts, system
  deployments — with the phase each device is in (downloading 63 %,
  installing…).
- **Notifications** in the console for deployments you started, devices
  registering, the server going away; each kind can be turned off in
  **Configuration**.
- **Prometheus** at `/metrics`: requests and latency, targets by status, each
  channel's progress, `qawk_fleet_releases_pending` and
  `qawk_fleet_releases_halted` (the two worth an alert), `qawk_leader`.
- **OpenTelemetry**: set `OTEL_EXPORTER_OTLP_ENDPOINT` and metrics and traces go
  to your collector.
- **Health**: `/live` (the process), `/health` (it can reach its database).

Details in [server/README.md](../server/README.md#metrics-prometheus).

---

## 14. Trying all of this with simulated devices

`demo/start.sh` gives you the channels, a catalogue, 270 devices and 16
systems. For more, or for your own server, `demo/simulate.sh` (see the
[README](../README.md#simulated-devices-and-load)). A few recipes:

| to see | do |
|---|---|
| a channel filling by rule | `simulate.sh --name shop --fleet lab:30`, then a channel with rule `attribute.ring==lab` |
| a release halting | give `dev` the set `app-broken 1.3.0` |
| a flaky fleet and the error threshold | `simulate.sh --name flaky --fleet beta:100 -- -fail-rate 0.15` |
| a system rolled back automatically | on the demo, `device-07`'s device3 already fails set 2.0: deploy manifest `device-system-2.0` over beta. On your own server: `simulate.sh --name sys --systems 8 -- -fail-where device=device-03,device_type=device3,set=2.0` (simulated systems are named `device-01`…, so not on a server that already has the demo's) |
| a maintenance window | assign with `"maintenanceWindow"`: the simulated device answers the skip as SWUpdate does and installs when it opens |
| load | `qawk-load -devices 10000 -interval 30s -act` |

Everything a simulated device does is visible in the console exactly as a real
device's would be.
