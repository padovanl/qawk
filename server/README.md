# Qawk

QubicaAMF's update server. It speaks the protocols of
[Eclipse hawkBit](https://eclipse.dev/hawkbit/) 1.1.0 — the one the devices
talk to and the one the console talks to — and is written to be the server we
keep: small, readable, and ours to extend.

- **Devices cannot tell it from hawkBit.** The images are frozen: SWUpdate's
  hawkBit client (suricatta) will keep sending what it sends today. Every
  answer of the device API is checked, field by field, against answers
  recorded from a real hawkBit 1.1.0.
- **The console works unchanged**, and so do scripts written for hawkBit and
  hawkBit's own `hawkbit-simple-ui`: the Management API has all 153 of
  hawkBit's operations, with its JSON and its error codes.
- **What hawkBit lacks** is added under `/qawk/v1`, never by changing what
  hawkBit's API returns. See [What Qawk adds](#what-qawk-adds).

Written in Go, on PostgreSQL. One static binary, one container image.

---

## Contents

1. [Running it](#running-it)
2. [Configuration](#configuration)
3. [How it is built](#how-it-is-built)
4. [hawkBit parity](#hawkbit-parity)
5. [Where Qawk differs from hawkBit, on purpose](#where-qawk-differs-from-hawkbit-on-purpose)
6. [What Qawk adds](#what-qawk-adds)
7. [Scaling: ten thousand devices, many instances](#scaling-ten-thousand-devices-many-instances)
8. [Testing](#testing)
9. [Extending it](#extending-it)
10. [Layout of this directory](#layout-of-this-directory)

---

## Running it

### The demo

```bash
demo/start.sh          # build the images, start it all, load sample data
demo/start.sh seed     # load the sample data again
demo/start.sh down     # stop and remove it all
```

The script starts PostgreSQL, Qawk on port 8080 and the console on 8090, loads
a catalogue, the channels dev → beta → prod and a system type, and starts
simulated devices (`qawk-sim`) that poll with a gateway token and take the
updates they are given. `demo/compose.yml` is the same for docker compose. A
device already pointed at hawkBit polls Qawk from its next poll, once it is
pointed at this host.

That setup is for the lab: PostgreSQL has no volume and the artifacts live in
the container, so — like hawkBit's in-memory database — a restart is an empty
server. For anything that must survive a restart, see
[Scaling](#scaling-ten-thousand-devices-many-instances).

### On its own

```bash
docker build -t qawk:local server
docker run -d --name qawk-db -e POSTGRES_USER=qawk -e POSTGRES_PASSWORD=qawk postgres:16-alpine
docker run -d --name qawk -p 8080:8080 --link qawk-db \
  -e QAWK_DATABASE_URL='postgres://qawk:qawk@qawk-db:5432/qawk?sslmode=disable' \
  -e QAWK_ADMIN_PASSWORD=change-me \
  qawk:local
```

On first start Qawk creates its schema, then the software module types (`os`,
`application`) and distribution set types (`os`, `os_app`, `app`) a fresh
hawkBit tenant starts with — same keys, names and module rules — because our
scripts rely on them existing.

---

## Configuration

Everything is an environment variable; nothing is read after startup.

| Variable | Default | Meaning |
|---|---|---|
| `QAWK_LISTEN` | `:8080` | address to listen on — hawkBit's port, so devices need no change |
| `QAWK_DATABASE_URL` | `postgres://qawk:qawk@localhost:5432/qawk?sslmode=disable` | PostgreSQL connection string |
| `QAWK_DB_WAIT` | `5m` | how long to wait for the database at startup. PostgreSQL's first start initialises its data directory before it listens -- over a minute, measured, on a busy disk -- so the default is generous |
| `QAWK_DB_MAX_CONNS` | `20` | this instance's connection pool; across all instances keep it under PostgreSQL's `max_connections` |
| `QAWK_ARTIFACT_DIR` | `/var/lib/qawk/artifacts` | where artifact bytes are stored |
| `QAWK_TENANT` | `DEFAULT` | the tenant this instance serves (the `{tenant}` of the device URL) |
| `QAWK_ADMIN_USER` | `admin` | the administrator: every permission, never stored, always works (other users live in the database) |
| `QAWK_ADMIN_PASSWORD` | `admin` | its password; must not be empty |
| `QAWK_USERS_FILE` | *(empty)* | a YAML file of users created or brought up to date at every start (see [Users from a file](#users-from-a-file)) |
| `QAWK_AUDIT_DAYS` | `180` | how long the audit log is kept; `0` keeps it for ever |
| `QAWK_METRICS_TOKEN` | *(empty)* | when set, `/metrics` answers only `Authorization: Bearer <token>`; empty leaves it open, for a scraper on an internal network |
| `QAWK_PUBLIC_URL` | *(empty)* | base of every link Qawk hands out; empty means "the address the client used", which is right unless a proxy rewrites it |
| `QAWK_POLLING_TIME` | `00:05:00` | device polling interval until one is set through the API |
| `QAWK_LOG_LEVEL` | `info` | `debug` logs every request |

Tenant settings — the gateway token, the polling interval, whether the
confirmation flow is on — are hawkBit's `/rest/v1/system/configs`, with
hawkBit's keys and defaults, stored in the database.

---

## How it is built

```
            devices (SWUpdate)            console, scripts, hawkbit-simple-ui
                  │                                     │
     /{tenant}/controller/v1/...                  /rest/v1/...          /qawk/v1/...
                  │                                     │                     │
        ┌─────────▼──────────┐              ┌───────────▼──────────┐          │
        │  internal/api/ddi  │              │  internal/api/mgmt   │   (additions)
        └─────────┬──────────┘              └───────────┬──────────┘          │
                  └─────────────────┬───────────────────┴─────────────────────┘
                          ┌─────────▼──────────┐
                          │  internal/service  │  what Qawk does: assign, the device
                          │                    │  state machine, rollouts, auto-assign
                          └─────────┬──────────┘
                ┌───────────────────┼───────────────────┐
        ┌───────▼───────┐   ┌───────▼────────┐   ┌──────▼──────────┐
        │ internal/store│   │internal/artifact│  │  internal/fiql  │
        │ every SQL     │   │ bytes by SHA-256│  │ q=... to SQL    │
        └───────┬───────┘   └────────────────┘   └─────────────────┘
                │
           PostgreSQL
```

The rules that shape it:

- **The service does not know about HTTP.** Assigning a set, a device polling,
  a device reporting, a rollout moving to its next group: each is one method
  of `internal/service`, one transaction. The two APIs translate requests into
  those calls and results into hawkBit's JSON. A third protocol — hawkBit's
  DMF over AMQP, when needed — is a third translator on the same service.
- **All SQL lives in `internal/store`,** next to the struct it fills. There is
  no ORM: the queries are short and it is useful to be able to read them.
- **Nothing a client types reaches SQL.** The `q=` query language is parsed by
  `internal/fiql` and compiled against a whitelist of fields per entity; every
  value becomes a bound parameter.
- **Errors are hawkBit's.** An error is not "a 400": it is the `errorCode`
  and `exceptionClass` hawkBit sends for the same mistake, because the console
  shows the message and branches on some codes.
- **Artifacts are content-addressed.** A file is stored once under its
  SHA-256 however many modules upload it; the database says which module has
  it under which name. The store is an interface, so an object store can
  replace the filesystem.

The schema is in `internal/db/migrations/`, applied in order at startup, each
in its own transaction, under a lock so two instances starting together take
turns.

---

## hawkBit parity

What "the same as hawkBit" means here, and how it is kept true.

### Device API (DDI)

All 16 operations: the root resource with its polling interval and the link
to what the device must do next (`deploymentBase`, `cancelAction`,
`confirmationBase`, `installedBase`, `configData`), the deployment with its
chunks and artifacts, feedback on deployments and cancellations, config data,
confirmation and auto-confirmation, the offline "installed version", artifact
lists, downloads and `.MD5SUM`.

Checked word for word against the recorded samples:

- the JSON of every answer, including the legacy chunk part names hawkBit
  still uses (`application` is `bApp`) and `download`/`update` per action type;
- the status codes: 200 with no body for a report, 404 with hawkBit's error
  for an unknown action, 410 for a report on a closed one, a bare 401 for a
  wrong token;
- the download headers a resumed or delta download relies on: `Accept-Ranges`,
  `Content-Range`, an `ETag` equal to the SHA-1, `Last-Modified`,
  `Content-Disposition`;
- the messages the server writes into an action's history —
  `Assignment initiated by user 'admin'`, `Update Server: Target retrieved
  update action and should start now the download.`, the cancellation
  bracket — because the console reads them to tell what a device is doing.

Authentication: target token, gateway token and anonymous access, as enabled
by the tenant configuration, in hawkBit's order.

### Management API

All 153 operations of hawkBit 1.1.0's Management API, listed in
[`reference/PARITY.md`](reference/PARITY.md): targets (with attributes,
metadata, tags, types, groups, auto-confirmation, actions and their history),
software modules and their artifacts, distribution sets (modules, assignment,
invalidation, statistics, metadata), the three kinds of type, both kinds of
tag, target filters with auto-assignment, rollouts (groups, conditions,
approval, pause, resume, stop, retry, trigger next group), the global action
list and the tenant configuration.

The JSON follows hawkBit's conventions, observed rather than assumed: an
object in a list carries only its `self` link and the same object on its own
carries all of them; a field without a value is left out; lists come in
`{content, total, size}`. The `q`, `sort`, `offset` and `limit` parameters
behave as hawkBit's: field names are case-insensitive, string comparisons are
too, `*` is a wildcard, an unknown field or enum value is
`rsqlInvalidField`.

`/v3/api-docs/<group>` serves hawkBit's own API description, reduced to the
operations Qawk has, so the console's compatibility check tells the truth.

### The business rules

The rules that decide what happens, taken from hawkBit's behaviour:

- a set can be assigned only if it is complete (every mandatory module type
  present) and valid, and only to targets whose type accepts its type — or
  nothing is assigned at all;
- assigning a set a target already has creates no action (`alreadyAssigned`);
- a new assignment sends the target's open actions to `canceling`; the device
  closes them itself, and only then gets the new one;
- the first assignment locks the set and its modules (`implicit.lock.enabled`):
  what was assigned can no longer change under a device;
- a finished action makes the target `in_sync` and asks it for its attributes
  again, so the slot and application versions it reports are current;
- a target registers itself at its first poll with a gateway token
  (`CONTROLLER_PLUG_AND_PLAY`);
- rollouts split their targets into groups — evenly, or by percentage and
  per-group query, never putting a target in two groups — and move to the
  next group when the success threshold is met, pausing when the error one is;
  once started, every group waiting is `scheduled` and the first runs;
- **scheduled deployments**: a rollout with `startAt` stays `ready` until
  then and starts by itself; a `timeforced` action is `attempt` until its
  force time and `forced` after; a `downloadonly` action is `skip` and closes
  when the device reports `downloaded`; an assignment with a **maintenance
  window** — a Quartz cron for when it opens (`0 30 2 * * ?`), how long it
  stays open (`01:00:00`) and the offset it is read in (`+01:00`) — tells the
  device to download but `skip` the install, `maintenanceWindow:
  unavailable`, until the window opens, then `available` and the action's own
  handling. The action shows `nextStartAt`. A window half given, unreadable,
  or never coming again is refused with hawkBit's
  `hawkbit.server.error.maintenanceScheduleInvalid`. Quartz's `L`, `W` and `#`
  are not supported. The `deploymentBase` link changes whenever what the
  device would be told changes (forced time reached, window opening), so a
  device that caches by URL reads it again.

---

## Where Qawk differs from hawkBit, on purpose

Each of these is in the contract test's list of deliberate deviations, with
the reason.

| hawkBit | Qawk | Why |
|---|---|---|
| A new rollout answers `creating` and its groups are filled in the background. | It answers `ready`: the groups are created in the same transaction. | Nothing to wait for. A client written for hawkBit waits for `ready`, and gets it at once. |
| A deleted module's or set's name and version are reserved for ever (soft delete). | They can be used again. | hawkBit's reservation is why the demo has to restart it to start over. Deleted rows are still kept for the history that points at them. |
| Every range request of a download writes a `download` entry into the action's history. | Only the start of a download does (no `Range`, or one starting at 0). | A delta update reads one file in hundreds of ranges; hawkBit's behaviour is why our start script had to lift its limit on status entries. |
| The 401 of the Management API carries `WWW-Authenticate`. | It does not. | The console calls the API with `fetch()`, and that header makes browsers pop up their own login dialog over it. |
| A device reporting `closed`/`success` finishes the action, whatever it had been told. | Outside an action's maintenance window, a success is taken as the skip acknowledged: the action goes to `scheduled`, stays open, and the installed set does not change. | SWUpdate answers `"update": "skip"` with `closed`, `success`, *"Skipped Update."* — measured on our devices. hawkBit takes it at its word and marks a device updated that is not, so maintenance windows could not be used with SWUpdate at all. With this, the device installs when the window opens: the link changes and it is told `forced`. |

---

## What Qawk adds

Everything Qawk offers beyond hawkBit lives under `/qawk/v1` and in separate
tables; hawkBit's API is never changed to carry it. The console uses these
directly.

| Feature | Status |
|---|---|
| `GET /qawk/v1/info` — what the server is and what it offers | done |
| Download progress and an "installing" phase: Qawk counts the bytes it serves (`/qawk/v1/downloads`); the console shows "downloading · 63%", then "installing" from the last byte until the device reports. The percentage is bytes handed to the network, so it runs a few MB ahead of the device; a delta, read in ranges, shows megabytes instead | done |
| A deleted name and version can be uploaded again | done |
| Background jobs on one instance among many, elected through PostgreSQL | done |
| Target groups (hawkBit 1.1's `/targetgroups`), stored as a column, filterable as `group==` | done |
| Fleets — beta, production, a customer site: devices join by hand or by a rule, a fleet's release reaches every member, one fleet is promoted from another (see below) | done |
| Users and roles in the database, with hawkBit's permissions — hawkBit only has users in its configuration (see below) | done |
| Personal API tokens, so scripts do not hold a password | done |
| An audit log: who changed what, when, from where, and every refused sign-in | done |
| Live events for the console (server-sent events), instead of polling | planned |
| Prometheus metrics at `/metrics`: requests and latency by API, targets by status, open actions, each fleet's progress, halted and pending releases, the leader, the database pool (see below) | done |
| The release pipeline: upstreams, gates, four-eyes approval, waves, error thresholds, freezes, temporary fleets; `qawk-sim` for simulated devices | done |
| Systems, after Mender Orchestrator: devices that work together (a 6hd and the two st05 and the hyper under it) updated as a whole, components in order, the whole system rolled back when one device fails; Mender's topology and manifest YAML in and out (see below) | done |
| Centres: a device says its centre (`attribute.centerid`), a centre is in a channel, and every device of it follows; system deployments by channel and centre (see below) | done |
| Every open deployment in one request (`/qawk/v1/deployments`), and a page's worth of target state in one (`/qawk/v1/targets/state`, `/qawk/v1/targets/attributes`) | done |
| Artifacts in an S3-compatible object store | planned |

Every route already declares the hawkBit permission it needs (`READ_TARGET`,
`UPDATE_REPOSITORY`, `HANDLE_ROLLOUT`, ...); today the one administrator has
all of them, and users with subsets will need no route to change.

### Fleets

A fleet is a set of devices that should run the same release. A device is in
at most one fleet (`targets.fleet_id`); the device itself knows nothing about
it — it still speaks plain DDI, and the image is unchanged.

- **Membership.** By hand (`PUT /qawk/v1/fleets/{id}/targets` with a list of
  controller ids; `DELETE` with the same body takes them out), or by the
  fleet's **rule**: a target query (`attribute.device_type==besx2`,
  `controllerId==lane-*`, ...). Every ten seconds the instance running the
  background jobs puts the devices that match a rule *and are in no fleet*
  into that fleet, so a device registering for the first time lands in the
  right one from what it reports. A device already in a fleet is never moved
  by a rule; move it by hand.
- **Release.** A fleet may carry a distribution set and a mode (`forced` or
  `soft`). Every member that has not been assigned it and has never had an
  action for it gets it — the same rule as auto-assignment, so a device where
  it failed is not sent it again every ten seconds. `distributionSetId: 0`
  removes the release and leaves the members alone.
- **Promotion.** `POST /qawk/v1/fleets/{prod}/promote {"from": <beta>}` gives
  production the release beta has: the beta → production step in one call.
- **Queries.** `fleet==beta` works in every target query, in the console's
  editor too.

| Route | Permission |
|---|---|
| `GET /qawk/v1/fleets` — every fleet, with `members`, `onRelease` (members running its release), `updating` (members with an open action), `failed` | `READ_TARGET` |
| `POST /qawk/v1/fleets` — `{name, description, colour, rule, distributionSetId, actionType}` | `CREATE_TARGET` |
| `GET` / `PUT` / `DELETE /qawk/v1/fleets/{id}` — deleting leaves the devices in no fleet | `READ_` / `UPDATE_` / `DELETE_TARGET` |
| `GET /qawk/v1/fleets/{id}/targets` — members, with what each runs and should run | `READ_TARGET` |
| `PUT` / `DELETE /qawk/v1/fleets/{id}/targets` — add / remove members | `UPDATE_TARGET` |
| `POST /qawk/v1/fleets/{id}/promote` | `UPDATE_TARGET` |

The console shows a **Fleets** page when the server lists `fleets` in
`/qawk/v1/info`: each fleet with its rule, release and a bar of how many
members run it, the members in a side panel, and edit / promote / delete.

### The release pipeline: dev → beta → prod, expo apart

Fleets chain. A fleet may name an **upstream** — beta names dev, prod names
beta — and then takes releases **only by promotion** from it; a fleet with no
upstream (dev, expo) is given releases directly. What a release must show in
the upstream before it may enter is the fleet's **gate**:

| Gate setting | Meaning |
|---|---|
| `gate.minDevices` | at least so many devices of the upstream run the release |
| `gate.minSuccess` | at least this percentage of the upstream's devices run it |
| `gate.soakMinutes` | it started in the upstream at least so many minutes ago |
| `gate.approvalRequired` | every release into this fleet waits for a second person |

A closed gate refuses the promotion (`409`, with the report line by line). A
person with `APPROVE_ROLLOUT` may **force** it, but only with a reason, which
stays in the release's history. When approval is required the promotion
answers `202` and waits in the queue (`GET /qawk/v1/releases?status=waiting_for_approval`)
until someone with `APPROVE_ROLLOUT` **other than who asked** approves it (four
eyes) or denies it. The built-in role `release-manager` is an operator who can
approve and force.

**By hand, or by itself.** By default a fleet is promoted **by hand**: the gate
does not promote anything, it only says whether someone may — a person looks
at it, decides, and promotes (from the console or the API). A fleet can
instead be set to **promote itself** (`"autoPromote": true`, "Promotion from
it: by itself" in the console): as soon as its gate opens, the engine
promotes it, as user `system`, through the same path — the same gate, the
approval when the fleet asks for one (anyone may approve what `system`
asked for), the history and the audit log. It asks once per release of its
upstream: a promotion approved or denied is not asked for again.

Inside a fleet a release goes out in **waves**: `wavePercent` of the members
at a time (0: all at once); the next wave when the last has finished, or
after `waveTimeoutMinutes` if some devices never answer. When the devices
that failed pass `errorThreshold` percent of those that finished, the release
**halts** by itself; nothing more is sent until someone resumes it
(`POST /qawk/v1/fleets/{id}/resume`), and only new failures count after that.
A release is `completed` when every member runs it; a device joining later
still gets it.

A **freeze** (`PUT /qawk/v1/fleets/{id}/freeze {reason, from, until}`, both
ends optional) stops every release reaching the fleet — promotions, direct
releases and the background delivery; planned freezes show in the console
before they start. A person can still assign one device by hand through the
hawkBit API; the audit log records who.

A **temporary** fleet — expo, the machines taken to a trade show — remembers
where each device came from (`home`). `POST /qawk/v1/fleets/{id}/return`
(all members, or `{"controllerIds": [...]}`) sends them back, and there they
get their own fleet's release again: a device is sent a release again when it
joins a fleet, not only once ever.

| Route | Permission |
|---|---|
| `GET /qawk/v1/fleets/{id}/gate?from=<id>` — would the gate open, and why | `READ_TARGET` |
| `POST /qawk/v1/fleets/{id}/promote` — `{from, force, reason}`; `200` started, `202` waiting for approval | `UPDATE_TARGET` (+ `APPROVE_ROLLOUT` to force) |
| `GET /qawk/v1/fleets/{id}/releases` — the fleet's history | `READ_TARGET` |
| `GET /qawk/v1/releases?status=…` — every fleet's; `waiting_for_approval` is the queue | `READ_TARGET` |
| `POST /qawk/v1/releases/{id}/approve`, `…/deny` — `{note}` | `APPROVE_ROLLOUT` |
| `POST /qawk/v1/fleets/{id}/resume` — a halted release goes on | `UPDATE_TARGET` |
| `PUT` / `DELETE /qawk/v1/fleets/{id}/freeze` | `UPDATE_TARGET` |
| `POST /qawk/v1/fleets/{id}/return` — devices of a temporary fleet go home | `UPDATE_TARGET` |

A fleet's JSON carries `upstreamId`, `temporary`, `gate`, `wavePercent`,
`waveTimeoutMinutes`, `errorThreshold`, `freeze`, the current `release`
(status, waves, who asked and who decided), its `progress` (members, on it,
updating, succeeded, failed) and the `pending` release, if any.

The console draws the chains as a pipeline, one card per fleet — release,
status, a bar of the devices on it, the wave, a freeze, an approval waiting —
with the approval queue on top; promotion shows the gate's report before
anything is sent.

**Simulated devices.** The Qawk image carries `qawk-sim`, which runs any
number of devices that register through the device API, report
`ring=<fleet>` among their attributes (so a rule `attribute.ring==beta` picks
them up), take deployments and report them done after a random time — without
downloading anything — and fail any whose module name contains `broken`.
They answer a deployment they are told to skip outside its maintenance window
as SWUpdate does (`closed`, `success`, *"Skipped Update."*) and then wait for
the window, and report a download-only one `downloaded`:

```bash
docker run --rm --network host --entrypoint qawk-sim qawk:local \
    -url http://localhost:8080 -token <gateway token> \
    -fleet dev:20 -fleet beta:40 -fleet prod:120 -fleet expo:8
```

`test/pipeline.py` runs the whole pipeline against a scratch server with it;
`demo/start.sh` runs it for the demo.

### Systems: updated as a whole, after Mender Orchestrator

Some devices only make sense together. A 6hd has two st05 and a hyper
attached under it; the st05 and the hyper must be on the new version before
the 6hd, and a group left half on one version and half on the other is worse
than one not updated at all. A centre has many such groups — tens, a
hundred or more; a neo-intel stands alone and belongs to none. [Mender Orchestrator](https://docs.mender.io/orchestrate-updates/overview)
solves this with a *topology* (what a system is made of), a *manifest* (what
each component should run, and in which order) and an orchestrator running
on one device of each system. Qawk keeps the first two, in Mender's own YAML,
and runs the orchestration on the server: the devices still speak plain DDI
and the image does not change.

| Mender | Qawk | |
|---|---|---|
| topology | system type | its components, each recognised by a target query (`attribute.device_type==6hd`), and the field that says which system a device is in (`attribute.system` reported by the device, or `metadata.system` set on it) |
| system | a value of that field | found from the devices; nothing to register |
| manifest | manifest | a distribution set per component, and an `order`: lower first, equal together |
| artifact_name | `name:version` of a distribution set | |
| orchestrator on a device | the server's background engine | on the elected leader, like rollouts |

A **system deployment** applies a manifest to every system of the type, or to
a list of them: at most `maxParallel` systems at a time; inside each, order by
order, a component already on its set left alone. When one device of a system
fails, every device of that system the deployment updated goes back to the
set it ran before — the whole system, not the one device — and the other
systems go on. Once more than `maxFailed` systems have failed, no new one is
started and the deployment ends `failed`. A system can also be rolled back by
hand. Every open system deployment shows in `/qawk/v1/deployments` (kind
`system`), so the console's In progress and dashboard see it.

| | |
|---|---|
| `GET/POST /qawk/v1/systemtypes`, `GET/PUT/DELETE /qawk/v1/systemtypes/{id}` | system types |
| `POST /qawk/v1/systemtypes/import`, `GET /qawk/v1/systemtypes/{id}/topology.yaml` | Mender topology YAML in (an existing name is updated) and out |
| `GET /qawk/v1/systemtypes/{id}/systems` | the systems found, and how many devices of each component |
| `GET/POST /qawk/v1/manifests`, `GET/PUT/DELETE /qawk/v1/manifests/{id}` | manifests |
| `POST /qawk/v1/manifests/import`, `GET /qawk/v1/manifests/{id}/manifest.yaml` | Mender manifest YAML in and out |
| `GET/POST /qawk/v1/systemdeployments`, `GET/DELETE /qawk/v1/systemdeployments/{id}` | deployments, with each system's run and each component's progress |
| `POST /qawk/v1/systemdeployments/{id}/start` · `pause` · `resume` · `abort` | created as a draft; started when ready |
| `POST /qawk/v1/systemdeployments/{id}/runs/{run}/rollback` | one system back, by hand |

Mender's YAML carries two Qawk fields, ignored by Mender: `qawk_system_key`
on a topology (default `metadata.system`) and `qawk_match` on a component
(default `attribute.device_type==<component_type>`):

```yaml
api_version: mender/v1
kind: topology
system_type: 6hd-system
qawk_system_key: metadata.system
components:
  - component_type: 6hd
  - component_type: st05
  - component_type: hyper
---
api_version: mender/v1
kind: manifest
name: 6hd-system-2026.09
system_types_compatible: [6hd-system]
component_types:
  st05:  {artifact_name: "st05-fw:2.0",   update_strategy: {order: 10}}
  hyper: {artifact_name: "hyper-fw:2.0",  update_strategy: {order: 10}}
  6hd:   {artifact_name: "app-full:1.2.0", update_strategy: {order: 20}}
```

(Two documents, imported one at a time.) Permissions follow hawkBit's: system
types are targets (`READ_TARGET`, `CREATE_TARGET`...), manifests and
deployments are rollouts (`CREATE_ROLLOUT`, `HANDLE_ROLLOUT`...). The console
has a Systems page for all of it. `qawk-sim -system 6hd:16:6hd=1,st05=2,hyper=1`
runs such systems; `test/systems.py` is the end-to-end test.

### Centres, channels, and systems by channel

A device says which centre it is in — `attribute.centerid` by default, a
setting (`PUT /qawk/v1/centres/settings {"field": "metadata.site"}`). A
**centre is put in a channel**, and every device of it follows: the 6hd with
its st05 and hyper, and the neo-intel alike. Moving a centre from beta to prod
moves all its devices, and they get what prod gets.

- The engine checks every few seconds and moves the devices that are not in
  their centre's channel, a hundred per transaction.
- A single machine taken to a trade show is **lent to a temporary channel**
  (expo) from Fleets → manage; it stays there until it is sent home. Moving
  one device of a centre by hand into another, not temporary, channel is
  refused: its centre would take it back within seconds.
- A centre cannot be put in a temporary channel: a device is lent, not a
  centre.
- Devices with no centre, or in a centre not put anywhere, keep the old
  rules: a fleet's rule, or by hand.

**Channels and systems.** A channel's release is one set for every member,
which a 6hd and the st05 under it cannot share. So a device that is part of a
system is **updated by system deployments, not by its channel's release**:
the release skips it, and the channel's progress, gates and waves count
without it (the Fleets page says how many of a channel's devices are in
systems). A system deployment takes a **channel** and, optionally, some
**centres**: only the systems whose devices are all in that channel, in
those centres. A system whose devices are in different channels is left out,
and the deployment says so. Inside each system the manifest's order holds
(hyper, then st05, then the 6hd, say), and a system that fails goes back on
its own; the rest of the channel goes on.

| | |
|---|---|
| `GET /qawk/v1/centres` | every centre the devices name or that was put somewhere: its channel, its devices, how many are in its channel |
| `PUT /qawk/v1/centres` `{"centres": ["c01","c02"], "fleetId": 3}` | put centres in a channel (`0`: in none); their devices follow |
| `PUT /qawk/v1/centres/settings` `{"field": "attribute.centerid"}` | where the devices say their centre |
| `POST /qawk/v1/systemdeployments` `{..., "fleetId": 3, "groups": ["c03"]}` | a system deployment over one channel, some centres |

A system type's centre is the centre field unless the type names another
(`groupKey`, or `qawk_group_key` in the topology YAML). `qawk-sim -system
6hd:16:6hd=1,st05=2,hyper=1:centers=4:ring=prod` shares simulated systems
out among four centres; `test/centres.py` is the end-to-end test.

### Releases through the orchestrator

A channel's release is one set for every member, which a 6hd and the st05
and hyper under it cannot share. So a release may carry, besides its set, a
**manifest**: when the release starts in a channel, the set goes to the
devices that stand alone (a neo-intel) and the **orchestrator** takes the
channel's systems with the manifest — a few systems at a time, **one centre
at a time** if the channel says so (the next centre once every system of the
last is done), in each system the manifest's order, a system that fails put
back as a whole.

- **Promoted, the manifest comes along**, by hand or by itself; a promotion by
  hand may leave it behind (`"orchestrator": false`): the set alone, the
  systems left as they are.
- **The release is complete** once its devices that stand alone run the set
  and the orchestrator has finished; the **gate** into the next channel checks
  the systems too (*the orchestrator took beta's systems … finished*).
- **More systems failed than the channel allows**: the orchestrator fails,
  and the release **halts**, as it does when too many devices fail.
- A new release supersedes the old one's orchestrator: the systems it had not
  started are skipped.

| | |
|---|---|
| `PUT /qawk/v1/fleets/{id}` `{"distributionSetId": 12, "manifestId": 3}` | a release with a set and a manifest (a channel with no upstream) |
| `PUT /qawk/v1/fleets/{id}` `{"orchestrator": {"maxParallel": 4, "maxFailed": 0, "byCentre": true}}` | how the channel's systems are taken |
| `POST /qawk/v1/fleets/{id}/promote` `{"from": 2, "orchestrator": false}` | promoted without the manifest (default: with it) |
| `POST /qawk/v1/systemdeployments` `{..., "byCentre": true}` | a system deployment by hand, one centre at a time |

A fleet shows its release's `manifest` and, under `systems`, how the
orchestrator is going: its deployment, the systems by state, the centre it is
on. The console has it on the Fleets page — the release dialog takes a
manifest, the promotion says whether the orchestrator comes along, a fleet's
settings say how — and in the dashboard's channels. `test/orchestrated.py` is
the end-to-end test.

### OpenTelemetry

Qawk sends its metrics and traces to an OpenTelemetry collector over
OTLP/HTTP, configured as every OpenTelemetry SDK is, by the standard
variables — and is silent unless they ask for it:

| Variable | Example | Meaning |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4318` | the collector, for both signals; setting it switches them on |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`, `…_TRACES_ENDPOINT` | | one signal only |
| `OTEL_EXPORTER_OTLP_HEADERS` | `authorization=Bearer …` | for a collector that wants credentials |
| `OTEL_METRICS_EXPORTER`, `OTEL_TRACES_EXPORTER` | `otlp` or `none` | switch one signal on or off explicitly |
| `OTEL_METRIC_EXPORT_INTERVAL` | `60000` | milliseconds between metric exports |
| `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG` | `parentbased_traceidratio`, `0.01` | **sample**: ten thousand devices polling make a span each |
| `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` | `qawk`, `deployment.environment=prod` | the resource; `service.instance.id` is the host (the pod) |
| `OTEL_SDK_DISABLED` | `true` | everything off |

**Metrics**: `http.server.request.duration` (histogram, seconds; attributes
`http.request.method`, `http.response.status_code` and `qawk.surface` —
`ddi`, `mgmt`, `qawk`), and the gauges of the table below under
OpenTelemetry names: `qawk.targets` (`qawk.status`), `qawk.actions.active`,
`qawk.rollouts.running`, `qawk.fleet.devices` / `.on_release` / `.updating` /
`.failed` (`qawk.fleet`), `qawk.fleet.releases.pending` / `.halted`,
`qawk.leader`, `qawk.db.connections` (`qawk.state`), `qawk.uptime`,
`qawk.goroutines`, `qawk.heap`.

**Traces**: a server span per request, named after the route it matched
(`GET /{tenant}/controller/v1/{controllerId}`, `POST /qawk/v1/fleets/{fleetId}/promote`),
with W3C trace-context propagation; `/health`, `/live` and `/metrics` are
left out.

Checked against the stock collector (`otel/opentelemetry-collector` with the
`debug` exporter): every instrument above arrives, with its attributes, and
the spans carry their route.

### Metrics (Prometheus)

`GET /metrics` also speaks Prometheus' text format, with no library behind
it, for a scraper where there is no collector: the same numbers.

| Metric | Kind | What |
|---|---|---|
| `qawk_http_requests_total{surface,method,code}` | counter | requests served; `surface` is `ddi` (devices), `mgmt` (hawkBit's API), `qawk` or `other` |
| `qawk_http_request_duration_seconds{surface}` | histogram | latency, 5 ms to 10 s |
| `qawk_targets{status}` | gauge | targets by update status |
| `qawk_actions_active`, `qawk_rollouts_running` | gauge | what is in flight |
| `qawk_fleet_devices{fleet}`, `qawk_fleet_on_release{fleet}`, `qawk_fleet_updating{fleet}`, `qawk_fleet_failed{fleet}` | gauge | each fleet's progress |
| `qawk_fleet_releases_pending`, `qawk_fleet_releases_halted` | gauge | approvals waiting, releases stopped by their threshold — the two worth an alert |
| `qawk_leader` | gauge | 1 on the instance running the background jobs; across instances the sum must be 1 |
| `qawk_db_connections{state}` | gauge | this instance's pool: acquired, idle, total |
| `qawk_uptime_seconds`, `qawk_goroutines`, `qawk_heap_bytes` | gauge | the process |

The counters are per instance (sum them); the database gauges are the same
on every instance (take one, or `max`). Scraping reads a handful of aggregate
queries, cheap even with ten thousand targets.

### Users, roles, API tokens and the audit log

hawkBit keeps its users in its configuration file. Qawk keeps them in the
database, managed from the console and shared by every instance.

**Who can sign in**, checked in this order:

1. The administrator from the environment (`QAWK_ADMIN_USER` /
   `QAWK_ADMIN_PASSWORD`), with every permission. It is never stored and
   always works: a new server can be set up, and a lost password is fixed by
   a restart.
2. An API token, `qawk_` followed by 48 hex digits, sent as
   `Authorization: Bearer <token>` or as the password of basic authentication
   (`curl -u alice:qawk_…`, for tools that only speak that). A token acts with
   its owner's permissions *at the time of use*: take a role away from
   someone and their tokens lose it too. Only the token's SHA-256 is stored;
   the token is shown once, when it is made. Expiry is optional.
3. A user stored in the database, with a password (PBKDF2-SHA256, 600,000
   iterations) and any number of roles. A disabled user cannot sign in.

**Roles** are named sets of hawkBit's own permissions, so every route keeps
the permission hawkBit gives it. Four are built in and rewritten at every
start: `admin` (everything), `operator` (targets, fleets, software, rollouts;
deletes nothing, configures nothing, approves nothing), `release-manager` (an
operator who also approves releases and forces a gate), `viewer` (reads
everything). Others are made from the console with any set of permissions.
Deleting a role takes it away from whoever had it. `SYSTEM_ADMIN` is what
manages users and roles and reads the audit log.

Checking a password costs about half a second on purpose, and the console
sends it with every request, so a successful check is remembered for thirty
seconds. Any change to a user, role or token forgets them all at once on the
instance that made it; other instances catch up within the thirty seconds.

**The audit log** records every request that changes something (method,
path, result, user, how they signed in, their address — the first
`X-Forwarded-For` behind a proxy) and every refused sign-in. Reads are not
recorded: a console refreshing every two seconds would bury the rest. It is
kept for `QAWK_AUDIT_DAYS` (180 by default), and is filtered like any
hawkBit list: `?q=user==alice;status=ge=400`.

| Route | Who |
|---|---|
| `GET /qawk/v1/me` — who you are, your roles and permissions | anyone signed in |
| `PUT /qawk/v1/me/password` — `{current, password}` | a database user |
| `GET /qawk/v1/permissions` — every permission a role can hold | anyone signed in |
| `GET` / `POST /qawk/v1/tokens`, `DELETE /qawk/v1/tokens/{id}` — your own tokens (`?all=true` and anyone's revocation with `SYSTEM_ADMIN`) | anyone signed in |
| `GET` / `POST /qawk/v1/users`, `GET` / `PUT` / `DELETE /qawk/v1/users/{id}`, `PUT /qawk/v1/users/{id}/password` | `SYSTEM_ADMIN` |
| `GET` / `POST /qawk/v1/roles`, `PUT` / `DELETE /qawk/v1/roles/{name}` | `SYSTEM_ADMIN` |
| `GET /qawk/v1/audit` — paged, newest first, `q` on `user`, `via`, `method`, `path`, `status`, `address`, `at` | `SYSTEM_ADMIN` |

In the console: **Users and roles** and **Audit log** appear for those with
`SYSTEM_ADMIN`; **My account** (password, tokens) for everyone. The header
shows who you are signed in as, with your roles.

#### Users from a file

A new server has one user, the administrator. A deployment that must come up
with its people already there lists them in a file and sets
`QAWK_USERS_FILE` to its path:

```yaml
users:
  - username: release-manager-1
    password: at-least-eight-characters
    roles: [release-manager]
  - username: operator-1
    password: another-password
    display_name: The night operator
    roles: [operator]
    enabled: true            # the default
```

```bash
docker run ... -v "$PWD/users.yaml:/etc/qawk/users.yaml:ro" \
  -e QAWK_USERS_FILE=/etc/qawk/users.yaml qawk:local
```

At every start each user in the file is created if missing, and otherwise
brought to what the file says: roles, whether it may sign in, the display name
when one is given, the password. Nothing is written when nothing differs, so a
restart leaves no trace in the audit log; changes are recorded as made by
`users-file`. Users not in the file are left alone. The rules are the API's (a
valid name, a password of at least 8 characters, roles that exist, never the
administrator's name), and a file that breaks them stops the server with the
user it could not take, rather than leaving it up without the people it
expects.

---

## Scaling: ten thousand devices, many instances

The target is a fleet of ten thousand devices polling every thirty seconds:
about 330 polls a second, plus downloads.

What makes that work:

- **The HTTP side is stateless.** Any number of Qawk instances can run behind
  a load balancer on the same database; a device can poll one and report to
  another.
- **Background jobs run once.** The rollout engine and auto-assignment run on
  whichever instance holds a PostgreSQL advisory lock. The lock belongs to a
  database connection, so an instance that dies — or loses its database —
  loses it, and another takes over within ten seconds. No extra component.
- **The polling path is short.** A poll is one transaction on the target's
  row and its open actions. The tenant settings it needs (token, interval)
  are cached for five seconds per instance, instead of being read on every
  request.
- **Rows a device and an operator both change are locked in order.** A
  report and an assignment on the same target cannot interleave.
- **A poll does not wait for the disk.** What it writes — when the device was
  last seen, from where, and the first time that it exists — is committed
  with `synchronous_commit = off`: lost in a crash, it is written again at
  the next poll. Everything else (assignments, reports, releases) commits
  synchronously. Without this, each poll waited for its own fsync, and on a
  busy disk ten thousand devices meant twenty-second stalls.

For more than one instance the artifacts must be shared: a volume every
instance mounts (ReadWriteMany), or — planned — an S3-compatible store.

**Measured** with `qawk-load` — ten thousand simulated devices, each polling
with the gateway token, answering config requests and installing what they
are given — against one Qawk instance with the default pool of 20
connections and PostgreSQL 16 in a container, on a lab machine whose disk
was busy with other builds (Linux reported 17–21% of the time stalled on
I/O during the runs):

| Devices | Polling every | Requests | p50 | p99 | Max | Errors | Server time, mean |
|---|---|---|---|---|---|---|---|
| 10,000 | 60 s | 167/s | 1 ms | 2 ms | 1.1 s | 0 of 39,995 | 3.0 ms |
| 10,000 | 30 s | 333/s | 1 ms | 2 ms | 1.2 s | 0 of 69,994 | 2.1 ms |
| 10,000 | 60 s, *before* the asynchronous poll commit | 162/s | 841 ms | 23.4 s | 25.6 s | 0 of 38,941 | 4.4 s |

The rare one-second maximum is the disk's; the process itself sat below
200 MiB of memory. Row 22 of the device demonstration puts ten thousand
devices behind the real console and moves a release through them; the
Kubernetes manifests are in `deploy/kubernetes/`. To run the load test:

```bash
docker run --rm --network host --ulimit nofile=65536:65536 --entrypoint qawk-load \
    qawk:local -url http://localhost:8080 -token <gateway token> \
    -devices 10000 -interval 30s -ramp 30s -duration 180s -act
```

---

## Testing

```bash
# unit tests (the query language)
docker run --rm -v "$PWD/server":/src -w /src golang:1.25-bookworm go test ./...

# the contract: replays the recorded hawkBit flow against a server
python3 server/test/contract.py http://localhost:8080
```

`test/contract.py` is the one that matters. It creates modules, sets and a
device of its own, walks through the flow recorded from hawkBit 1.1.0 — a
device registering, being given a set, reading it, downloading ranges,
reporting, being told to cancel, the operator's side of the same story,
filters, tags, a rollout — and compares every answer with the recorded one:
status codes, fields and their types, link names, the vocabulary (statuses,
history messages, error codes), download headers and bytes. Run against
hawkBit itself, the same test passes: that is how it is known to test the
contract and not Qawk's own idea of it.

**Careful:** it sets the tenant's gateway token. Against a server real devices
use, pass the existing one, or they are locked out:

```bash
QAWK_CONTRACT_TOKEN=<gateway token> python3 server/test/contract.py
```

What Qawk adds has its own end-to-end tests, with simulated devices from
`qawk-sim` (they need Docker and a scratch server: they create users, sets
and fleets with a random suffix):

```bash
# fleets and the release pipeline: rules, direct releases, gates, waves,
# four-eyes approval, freezes, expo and home, halts, forcing, history, audit
python3 server/test/pipeline.py http://localhost:18080

# hawkBit's rollouts: groups in sequence, error threshold and pause, retry,
# triggerNextGroup, pause/resume, approval and denial, stop, fleet== queries
python3 server/test/rollouts.py http://localhost:18080

# scheduled deployments: maintenance windows, timeforced, download-only, startAt
python3 server/test/scheduled.py http://localhost:18080

# systems: Mender YAML in and out, systems found, orders, maxParallel,
# a whole system rolled back, maxFailed, rollback by hand
python3 server/test/systems.py http://localhost:18080

# centres in channels, devices following their centre, a device lent to a
# temporary channel, releases leaving systems alone, deployments by channel
python3 server/test/centres.py http://localhost:18080

# a channel's release through the orchestrator: the set for the devices that
# stand alone, the manifest for the systems, centre by centre; promoted with or
# without it; the gate waiting for the systems; halted when they fail
python3 server/test/orchestrated.py http://localhost:18080

# promotion by hand (the default), by itself, by itself with approval
python3 server/test/autopromote.py http://localhost:18080
```

The console's own live tests (`console/test/*-live.mjs`) run against
Qawk as they run against hawkBit.

---

## Extending it

- **A new endpoint** is a route in `internal/api/mgmt` (or a new package under
  `internal/api` for `/qawk/v1`), a method on the service if it changes
  anything, and the queries it needs in `internal/store`. Declare its
  permission on the route.
- **A new field on an entity**: a migration in `internal/db/migrations/`
  (never edit an applied one), the column in the store's select and scan, the
  field in `internal/model`, and — if it should be filterable — one line in
  `internal/store/fields.go`.
- **A new query field** is one line in `fields.go`; the parser and the SQL
  compiler need nothing.
- **Another artifact store** implements `artifact.Store`.
- **Another protocol** (DMF over AMQP) calls `internal/service` like the two
  HTTP APIs do.

---

## Layout of this directory

```
cmd/qawk/            the binary: configuration, database, HTTP server, shutdown
cmd/qawk-load/       load generator: thousands of devices polling
cmd/qawk-sim/        simulated devices that take updates (demos, pipeline tests)
internal/
  api/ddi/           the device API
  api/mgmt/          the Management API, one file per area
  api/qawkapi/       /qawk/v1: info, downloads, fleets and releases, users
  artifact/          artifact bytes, by SHA-256
  auth/              the request's user and permissions
  config/            environment variables
  db/                pool, migrations (db/migrations/*.sql)
  fiql/              the q= query language, parser and SQL compiler (+ tests)
  httpx/             JSON, hawkBit's errors, paging, links
  metrics/           request counters and gauges, /metrics
  model/             the entities, as plain structs
  openapi/           /v3/api-docs, built from hawkBit's own description
  server/            wiring, /health, /live, the gauges
  service/           what Qawk does (fleets.go: the pipeline)
  store/             every SQL statement
  telemetry/         OpenTelemetry: OTLP metrics and traces
  tenantcfg/         the tenant configuration keys and their defaults
  users/             who may sign in: users, roles, tokens, the audit log
reference/           hawkBit 1.1.0's API descriptions and recorded answers
deploy/kubernetes/   Deployment, Service, PDB, HPA; a lab PostgreSQL
test/contract.py     the contract test
test/pipeline.py     fleets and the release pipeline, with qawk-sim
test/rollouts.py     rollouts, with qawk-sim
Dockerfile
```
