# Qawk

An over-the-air update server for fleets of devices, and a web console for it.

Qawk speaks the protocols of [Eclipse hawkBit](https://eclipse.dev/hawkbit/)
1.1.0: devices that update from hawkBit (SWUpdate's *suricatta*, or any client
of hawkBit's Direct Device Integration API) and tools written for hawkBit's
Management API work with it unchanged. On top of that it adds what running a
real fleet needs: release channels with gates and approvals, systems of
devices updated as a whole, users and roles, an audit log, metrics and
tracing, and several instances behind one load balancer.

It is written in Go on PostgreSQL: one static binary, one container image. The
console is plain JavaScript with no build step, served by a small Python
proxy, and works with a stock hawkBit 1.1.0 as well.

- [What is in it](#what-is-in-it)
- [Try it in five minutes](#try-it-in-five-minutes)
- [Run it for real](#run-it-for-real)
- [Connect devices](#connect-devices)
- [The console](#the-console)
- [Simulated devices and load](#simulated-devices-and-load)
- [Kubernetes](#kubernetes)
- [Develop and test](#develop-and-test)
- [Repository layout](#repository-layout)
- [License](#license)

---

## What is in it

**hawkBit, the same.** All 16 operations of the device API and all 153 of the
Management API, with hawkBit's JSON, status codes, error codes, query language
(`q=name==app*;version==1.*`), paging and download headers. A contract test
replays a flow recorded from a real hawkBit 1.1.0 and compares every answer
field by field; the few deliberate differences are listed, with their
reasons, in [server/README.md](server/README.md#where-qawk-differs-from-hawkbit-on-purpose).

**What Qawk adds**, under `/qawk/v1`, never by changing hawkBit's API:

| | |
|---|---|
| **Fleets and a release pipeline** | devices join a fleet by hand or by a rule (`attribute.ring==beta`); fleets chain, dev → beta → prod; a release is promoted through a gate (devices on it, share of success, soak time) and, when asked, a second person's approval; it goes out in waves and halts by itself over an error threshold; freezes; temporary fleets whose devices go home afterwards |
| **Systems** | devices that work together updated as one, after Mender Orchestrator: components in order, the whole system rolled back when one of its devices fails; Mender's topology and manifest YAML in and out |
| **Centres** | a device says where it is (`attribute.centerid`), a centre belongs to a channel, and its devices follow it |
| **Scheduling** | maintenance windows (a Quartz cron, a duration, an offset), rollouts that start at a set time, time-forced and download-only deployments |
| **Users** | users and roles in the database with hawkBit's permissions, built-in roles `admin`, `operator`, `release-manager`, `viewer`; personal API tokens; users from a file at startup |
| **Audit log** | every change and every refused sign-in: who, what, when, from where |
| **Operations** | Prometheus metrics at `/metrics`, OpenTelemetry over OTLP, `/live` and `/health`, download progress per device, background jobs elected through PostgreSQL so any number of instances can run |
| **Scale** | measured with 10,000 devices polling every 30 s: 333 requests/s, p99 2 ms |

The full description of every feature, route and rule is in
[server/README.md](server/README.md).

**The console** ([console/](console/)): dashboard, targets with the columns
you choose, distribution sets and modules with upload checks, deployments by
device, type or query with a live match count, rollouts, target filters and
auto-assignment, fleets and the pipeline, systems and centres, users, roles,
tokens and the audit log, themes, notifications. Against a stock hawkBit it
shows the hawkBit part and hides the rest.

**Tools**, in the server image: `qawk-sim`, simulated devices that take
updates and report how they went; `qawk-load`, a load generator.

---

## Try it in five minutes

Needs **docker**, **python3** and **curl**, and ports 8080 and 8090 free.

```bash
git clone https://github.com/padovanl/qawk.git
cd qawk
demo/start.sh
```

It builds the two images, starts PostgreSQL, the server and the console, loads
sample data, and starts simulated devices:

- a catalogue: `app` 1.0.0 to 1.2.0, `app-broken` 1.3.0 (the simulated
  devices fail anything named *broken*), `os`, `device2-fw`, `device3-fw`;
- channels `dev` → `beta` → `prod` (prod needs approval) and a temporary
  `expo`;
- about 270 simulated devices in those channels, and 16 simulated *systems*
  (a `device1` with two `device2` and a `device3`) in four centres;
- `dev` is given `app` 1.1.0, so something is moving when you open the page.

Open **http://localhost:8090** and sign in as `admin` / `changeme`.

```bash
demo/start.sh seed     # load the sample data again
demo/start.sh down     # stop and remove everything (the demo keeps no data)
```

Everything is configurable through the environment:

| Variable | Default | |
|---|---|---|
| `QAWK_ADMIN_PASSWORD` | `changeme` | the administrator's password |
| `QAWK_PORT` | `8080` | the server |
| `CONSOLE_PORT` | `8090` | the console |
| `PROD_DEVICES` | `200` | simulated devices in prod |
| `SYSTEMS` | `16` | simulated systems |
| `USERS_FILE` | *(none)* | a [users file](#users) for more people than the administrator |

The same with docker compose: see [demo/compose.yml](demo/compose.yml).

Things to try: promote `dev`'s release to `beta` from **Fleets** and watch the
waves; give `dev` the broken release and watch it halt; approve a release into
`prod`; deploy manifest `device-system-2.0` to the systems in **Systems**.

---

## Run it for real

### Images

```bash
docker build -t qawk:local server/
docker build -t qawk-console:local console/
```

### Server, database and console

```bash
docker network create qawk

docker run -d --name qawk-db --network qawk --restart unless-stopped \
  -v qawk-db:/var/lib/postgresql/data \
  -e POSTGRES_USER=qawk -e POSTGRES_PASSWORD='db-secret' -e POSTGRES_DB=qawk \
  postgres:16-alpine

docker run -d --name qawk --network qawk --restart unless-stopped -p 8080:8080 \
  -v qawk-artifacts:/var/lib/qawk \
  -e QAWK_DATABASE_URL='postgres://qawk:db-secret@qawk-db:5432/qawk?sslmode=disable' \
  -e QAWK_ADMIN_PASSWORD='a-long-admin-password' \
  qawk:local

docker run -d --name qawk-console --network qawk --restart unless-stopped -p 8090:8090 \
  -e HB_URL=http://qawk:8080 \
  qawk-console:local
```

On its first start Qawk creates its schema, the built-in roles and hawkBit's
default types. Artifacts are stored under `/var/lib/qawk`, so that volume and
the database's are what to back up.

**Set `QAWK_ADMIN_PASSWORD`.** Without it the administrator's password is
`admin`. The administrator is never stored: it always works, which is how a
new server is set up and how a lost password is fixed.

**TLS** is not built in: put Qawk and the console behind a reverse proxy that
terminates it. If the proxy changes the address devices reach Qawk at, set
`QAWK_PUBLIC_URL` so download links point there. Give the proxy a generous
body size and timeout: artifacts are uploaded and downloaded through it.

### Configuration

Everything is an environment variable, read once at startup.

| Variable | Default | |
|---|---|---|
| `QAWK_DATABASE_URL` | `postgres://qawk:qawk@localhost:5432/qawk?sslmode=disable` | PostgreSQL |
| `QAWK_ADMIN_USER` / `QAWK_ADMIN_PASSWORD` | `admin` / `admin` | the administrator |
| `QAWK_USERS_FILE` | *(none)* | [users](#users) created or updated at every start |
| `QAWK_LISTEN` | `:8080` | hawkBit's port, so devices need no change |
| `QAWK_PUBLIC_URL` | *(the request's address)* | base of the links Qawk hands out |
| `QAWK_ARTIFACT_DIR` | `/var/lib/qawk/artifacts` | where artifacts are stored |
| `QAWK_TENANT` | `DEFAULT` | the tenant in the device URL |
| `QAWK_POLLING_TIME` | `00:05:00` | device polling interval, until set through the API |
| `QAWK_DB_MAX_CONNS` | `20` | connection pool per instance |
| `QAWK_DB_WAIT` | `5m` | how long to wait for the database at startup |
| `QAWK_AUDIT_DAYS` | `180` | audit log retention, `0` for ever |
| `QAWK_METRICS_TOKEN` | *(none)* | bearer token for `/metrics`; open without it |
| `QAWK_LOG_LEVEL` | `info` | `debug` logs every request |
| `OTEL_*` | *(none)* | the standard OpenTelemetry variables turn on OTLP export |

The console has one: `HB_URL`, the server it talks to
(`http://hawkbit:8080` by default in its image).

### Users

A new server has one user, the administrator. Others are created in the
console (**Users and roles**), through `/qawk/v1/users`, or listed in a file
the server reads at every start:

```yaml
users:
  - username: release-manager-1
    password: at-least-eight-characters
    roles: [release-manager]
  - username: operator-1
    password: another-password
    display_name: The night operator
    roles: [operator]
```

```bash
docker run ... -v "$PWD/users.yaml:/etc/qawk/users.yaml:ro" \
  -e QAWK_USERS_FILE=/etc/qawk/users.yaml qawk:local
```

Missing users are created; existing ones are brought to the file's roles,
display name, enabled flag and password. Users not in the file are left alone.
A file that breaks the rules (a password under 8 characters, an unknown role)
stops the server with the user it could not take.

---

## Connect devices

Devices poll `http://<server>:8080/<tenant>/controller/v1/<controller id>`,
exactly as they poll hawkBit. With a **gateway token** they register
themselves at their first poll. Set one in the console (**Configuration**) or
through the API:

```bash
A='-u admin:a-long-admin-password'
curl $A -X PUT -H 'Content-Type: application/json' -d '{"value": true}' \
  http://localhost:8080/rest/v1/system/configs/authentication.gatewaytoken.enabled
curl $A -X PUT -H 'Content-Type: application/json' -d '{"value": "a-random-token"}' \
  http://localhost:8080/rest/v1/system/configs/authentication.gatewaytoken.key
```

For **SWUpdate**, the suricatta section of `swupdate.cfg`:

```
suricatta: {
  url          = "http://updates.example.com:8080";
  tenant       = "DEFAULT";
  id           = "device-0001";
  gatewaytoken = "a-random-token";
};
```

A device's attributes (what SWUpdate sends as config data) are what fleets,
centres and systems are built on: `attribute.ring==beta`,
`attribute.centerid==c01`, `attribute.device_type==device2`.

Uploading software is hawkBit's Management API: create a software module,
upload its artifact, put it in a distribution set, assign the set. Any script
written for hawkBit does it; so does the console.

---

## The console

The image above is the simplest way. Without docker it needs only python3:

```bash
python3 console/serve.py --port 8090 --hawkbit http://localhost:8080
```

`serve.py` serves the page and proxies the API, so the browser sees one
origin and the server needs no CORS. It keeps no credentials: the browser's
own `Authorization` header is passed through, and closing the tab signs out.

It works against a stock **hawkBit 1.1.0** too: point `--hawkbit` (or
`HB_URL`) at it. The console asks the server what it is and shows only what it
supports; a bar warns when an endpoint it calls is missing.

---

## Simulated devices and load

Both tools are in the server image.

```bash
# devices that take updates: 20 in dev, 40 in beta, reporting ring=<fleet>;
# anything whose name contains "broken" fails
docker run --rm --network host --entrypoint qawk-sim qawk:local \
  -url http://localhost:8080 -token a-random-token \
  -fleet dev:20 -fleet beta:40

# 16 systems of one device1, two device2 and a device3, in four centres;
# one component made to fail a given set
docker run --rm --network host --entrypoint qawk-sim qawk:local \
  -url http://localhost:8080 -token a-random-token -prefix ctr \
  -system device:16:device1=1,device2=2,device3=1:centers=4 \
  -fail-where device=device-07,device_type=device3,set=2.0

# how many polls the server holds
docker run --rm --network host --ulimit nofile=65536:65536 --entrypoint qawk-load qawk:local \
  -url http://localhost:8080 -token a-random-token \
  -devices 10000 -interval 30s -ramp 30s -duration 180s -act
```

`-help` lists every flag: polling interval, install time, failure rate, and
more.

---

## Kubernetes

[server/deploy/kubernetes/](server/deploy/kubernetes/) has a Deployment of
three instances with probes, a Service, a PodDisruptionBudget, an autoscaler,
a shared artifact volume (ReadWriteMany) and, for a lab, a PostgreSQL. The
commands are at the top of `qawk.yaml`. How instances share the work, and the
numbers behind the defaults, are in
[server/README.md](server/README.md#scaling-ten-thousand-devices-many-instances).

---

## Develop and test

**Server** — Go 1.25:

```bash
cd server
go build ./...
go test ./...
```

or without Go installed:
`docker run --rm -v "$PWD/server":/src -w /src golang:1.25-bookworm go test ./...`.

End-to-end tests, against a **scratch** server (they change its configuration
and create data):

```bash
python3 server/test/contract.py     http://localhost:8080   # the hawkBit contract
python3 server/test/pipeline.py     http://localhost:8080   # fleets and the pipeline
python3 server/test/rollouts.py     http://localhost:8080
python3 server/test/scheduled.py    http://localhost:8080
python3 server/test/systems.py      http://localhost:8080
python3 server/test/centres.py      http://localhost:8080
python3 server/test/orchestrated.py http://localhost:8080
python3 server/test/autopromote.py  http://localhost:8080
```

**Console** — Node 18 or later, for the tests only:

```bash
node console/test/smoke.mjs              # the module tree loads; no server needed
node console/test/compat.mjs             # every endpoint called is in the compatibility list
node console/test/fiql-live.mjs http://localhost:8080 admin changeme   # the query editor agrees with the server
``` After changing the console, `console/run-console.sh rebuild`
restarts the demo's console alone.

---

## Repository layout

```
server/                 Qawk
  cmd/qawk/             the server
  cmd/qawk-sim/         simulated devices
  cmd/qawk-load/        load generator
  internal/             APIs, service, store, users, metrics (server/README.md)
  reference/            hawkBit 1.1.0's API descriptions and recorded answers
  deploy/kubernetes/    manifests
  test/                 end-to-end tests
  Dockerfile
console/                the web console: index.html, js/, serve.py, test/
  Dockerfile
demo/                   start.sh, seed.py, compose.yml
```

## License

MIT — see [LICENSE](LICENSE). hawkBit is a trademark of the Eclipse
Foundation; Qawk is not affiliated with it.
