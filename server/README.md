# Qawk

QubicaAMF's update server. It speaks the protocols of
[Eclipse hawkBit](https://eclipse.dev/hawkbit/) 1.1.0 — the one the devices
talk to and the one the console talks to — and is written to be the server we
keep: small, readable, and ours to extend.

- **Devices cannot tell it from hawkBit.** The images are frozen: SWUpdate's
  hawkBit client (suricatta) will keep sending what it sends today. Every
  answer of the device API is checked, field by field, against answers
  recorded from a real hawkBit 1.1.0.
- **The console works unchanged**, and so do the scripts in `ota/hawkbit/` and
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

### With the rest of the OTA stack

```bash
./ota/hawkbit/start-hawkbit.sh                  # Qawk (the default on this branch)
./ota/hawkbit/start-hawkbit.sh --server hawkbit # the stock hawkBit 1.1.0, as before
./ota/hawkbit/start-hawkbit.sh --rebuild        # rebuild the Qawk image first
./ota/hawkbit/start-hawkbit.sh --stop           # stop everything
```

The script starts PostgreSQL and Qawk on port 8080, with the same gateway
token and the same target types hawkBit got, and the console on 8090. The Qawk
container carries the network alias `hawkbit`, so the console and
`hawkbit-simple-ui` reach it without being told anything changed. A device
already pointed at hawkBit on that host polls Qawk from its next poll.

That setup is for the lab: PostgreSQL has no volume and the artifacts live in
the container, so — like hawkBit's in-memory database — a restart is an empty
server. For anything that must survive a restart, see
[Scaling](#scaling-ten-thousand-devices-many-instances).

### On its own

```bash
docker build -t qawk:local ota/qawk
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
| `QAWK_AUDIT_DAYS` | `180` | how long the audit log is kept; `0` keeps it for ever |
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
  next group when the success threshold is met, pausing when the error one is.

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
| Prometheus metrics | planned |
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
the permission hawkBit gives it. Three are built in and rewritten at every
start: `admin` (everything), `operator` (targets, fleets, software, rollouts;
deletes nothing, configures nothing, approves nothing), `viewer` (reads
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

For more than one instance the artifacts must be shared: a volume every
instance mounts (ReadWriteMany), or — planned — an S3-compatible store.

Kubernetes manifests, and a load test that simulates the fleet and records
what it measured, are the next step of this work.

---

## Testing

```bash
# unit tests (the query language)
docker run --rm -v "$PWD/ota/qawk":/src -w /src golang:1.25-bookworm go test ./...

# the contract: replays the recorded hawkBit flow against a server
python3 ota/qawk/test/contract.py http://localhost:8080
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
QAWK_CONTRACT_TOKEN=$(cat ota/keys/hawkbit-gateway-token) python3 ota/qawk/test/contract.py
```

The console's own live tests (`ota/hawkbit-ui/test/*-live.mjs`) run against
Qawk as they run against hawkBit, and the full OTA matrix in
`ota/TESTBOOK.md` is the end-to-end proof: real devices, real images, real
updates, through Qawk.

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
internal/
  api/ddi/           the device API
  api/mgmt/          the Management API, one file per area
  artifact/          artifact bytes, by SHA-256
  auth/              Management authentication and permissions
  config/            environment variables
  db/                pool, migrations (db/migrations/*.sql)
  fiql/              the q= query language, parser and SQL compiler (+ tests)
  httpx/             JSON, hawkBit's errors, paging, links
  model/             the entities, as plain structs
  openapi/           /v3/api-docs, built from hawkBit's own description
  server/            wiring, /qawk/v1/info, /health
  service/           what Qawk does
  store/             every SQL statement
  tenantcfg/         the tenant configuration keys and their defaults
reference/           hawkBit 1.1.0's API descriptions and recorded answers
test/contract.py     the contract test
Dockerfile
```
