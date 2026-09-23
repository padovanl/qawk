<div align="center">

<img src="console/qawk-logo.svg" alt="Qawk" width="88">

# Qawk

**Over-the-air updates for fleets of devices — and for the machines that only make sense updated together.**

Speaks [Eclipse hawkBit](https://eclipse.dev/hawkbit/) 1.1.0, so your devices and tools work unchanged.<br>
Adds release channels, centres, and an orchestrator for systems of devices.

[![Licence: AGPL v3](https://img.shields.io/badge/licence-AGPL--3.0-blue.svg)](LICENSE)
[![hawkBit](https://img.shields.io/badge/hawkBit-1.1.0-8a2be2.svg)](#-hawkbit-the-same)
[![Go](https://img.shields.io/badge/Go-1.25-00ADD8.svg)](server/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16+-336791.svg)](#-run-it-for-real)
[![Docs](https://img.shields.io/badge/docs-padovanl.github.io%2Fqawk-3ba9a1.svg)](https://padovanl.github.io/qawk/)

**[📖 Documentation](https://padovanl.github.io/qawk/)** ·
[🚀 Get started](https://padovanl.github.io/qawk/start/) ·
[🖱️ Console guide](https://padovanl.github.io/qawk/console/) ·
[⌨️ API reference](https://padovanl.github.io/qawk/api/)

</div>

---

## 🤔 What is this?

An update server has one job: **get the right software onto the right machines
without breaking any of them**. Qawk does that job the way a real fleet works.

🔌 **It is hawkBit, so nothing has to change.** All 16 operations of the device
API and all 153 of the Management API, with hawkBit's JSON, status codes, error
codes, query language, paging and download headers. A device running SWUpdate's
*suricatta* is pointed at a different host and carries on. A script written for
hawkBit keeps working.

🚦 **And then it is more than hawkBit.** Releases move down a pipeline —
`dev → beta → prod` — through a gate that will not open until enough devices have
run the release for long enough. Devices are grouped by **where they physically
are**. Machines that work together are updated **in the order you decide**, and put
back together when one of them fails.

```
     dev  ──promote──▶  beta  ──promote──▶  prod
      │                  │                   │
   given directly     gate opens          gate + a
                      by itself        second person
```

---

## ✨ What is in it

| | |
|---|---|
| 🐝 **hawkBit, the same** | All 16 device operations and all 153 management operations. A contract test replays a flow recorded from a real hawkBit 1.1.0 and compares every answer field by field; the [five deliberate differences](https://padovanl.github.io/qawk/hawkbit/#differences) are listed with their reasons. |
| 🚦 **Channels and a release pipeline** | Devices join by rule (`attribute.ring==beta`); channels chain `dev → beta → prod`; a release is promoted through a **gate** (devices on it, share of success, soak time) and, when asked, a **second person's approval**. It goes out in waves and **halts by itself** over an error threshold. Freezes. Temporary channels whose devices go home afterwards. |
| 🧩 **Systems (the orchestrator)** | Devices that work together, updated as one, after [Mender Orchestrator](https://docs.mender.io/orchestrate-updates/overview) — components in a chosen order, **the whole system rolled back when one device fails**, and one system [taken again](https://padovanl.github.io/qawk/orchestrator/#recovery) once you know why. Mender's topology and manifest YAML in and out. Runs server-side: **nothing is installed on the devices.** |
| 🏢 **Centres** | A device says where it is (`attribute.centerid`), a **centre** goes in a channel, and all its devices follow. You move a place, not a list of machines. |
| ⏰ **Scheduling** | Maintenance windows (a Quartz cron, a duration, an offset), rollouts that start at a set time, time-forced and download-only deployments. |
| 👥 **Users** | Users and roles in the database with hawkBit's permissions; built-in `admin`, `operator`, `release-manager`, `viewer`; personal API tokens; users from a file at startup. |
| 📋 **Audit log** | Every change and every refused sign-in: who, what, when, from where. |
| 🔒 **HTTPS, on its own** | A certificate and a key and it terminates TLS itself — TLS 1.2 floor, 1.3 when the client can. Mutual TLS with `QAWK_TLS_CLIENT_CA`; a redirect for devices still on the old plain-HTTP URL. Or put a proxy in front, as before. |
| 📊 **Operations** | Prometheus at `/metrics`, OpenTelemetry over OTLP, `/live` and `/health`, download progress per device, background jobs elected through PostgreSQL so any number of instances can run. |
| ⚡ **Scale** | Measured with 10,000 devices polling every 30 s: **333 requests/s, p99 2 ms**. |

🖥️ **The console** ([`console/`](console/)) — dashboard, targets with the columns
you choose, distribution sets and modules with upload checks, deployments by
device, type or query with a live match count, rollouts, filters and
auto-assignment, channels and the pipeline, systems and centres, users, roles,
tokens and the audit log, two themes, notifications. Plain JavaScript, **no build
step**. Against a stock hawkBit it shows the hawkBit part and hides the rest.

🧪 **Tools**, in the server image — `qawk-sim`: simulated devices that register,
poll, take updates and report how they went. `qawk-load`: a load generator.

---

## 🚀 Try it in five minutes

Needs **docker**, **python3** and **curl**, and ports 8080 and 8090 free.

```bash
git clone https://github.com/padovanl/qawk.git
cd qawk
demo/start.sh
```

It builds the images, starts PostgreSQL, the server and the console, loads sample
data and starts simulated devices:

- 📦 a catalogue: `app` 1.0.0 → 1.2.0, `app-broken` 1.3.0 (the simulated devices
  fail anything named *broken*, on purpose), `os`, `device2-fw`, `device3-fw`;
- 🚦 channels `dev` → `beta` → `prod` (prod needs approval) and a temporary `expo`;
- 📟 about **270 simulated devices** and **16 simulated systems** — a `device1`
  with two `device2` and a `device3`;
- 🏢 **four centres**, each holding both kinds of machine: `c01`/`c02` in `beta`,
  `c03`/`c04` in `prod`. Every device in them reports its `centerid` and follows
  its centre, the way a real fleet is arranged — `dev` and `expo` have none and
  reach their channel by rule instead;
- ▶️ `dev` already has `app` 1.1.0, so something is moving when you open the page.

👉 Open **http://localhost:8090**, sign in as `admin` / `changeme`.

```bash
demo/start.sh seed     # load the sample data again
demo/start.sh down     # stop and remove everything (the demo keeps no data)
```

| Variable | Default | |
|---|---|---|
| `QAWK_ADMIN_PASSWORD` | `changeme` | the administrator's password |
| `QAWK_PORT` / `CONSOLE_PORT` | `8080` / `8090` | the server, the console |
| `PROD_DEVICES` | `200` | simulated devices in prod |
| `SYSTEMS` | `16` | simulated systems |

**Things to try** 🎯 — promote `dev`'s release to `beta` from **Fleets** and watch
the waves · give `dev` the broken release and watch it **halt by itself** · approve
a release into `prod` · deploy manifest `device-system-2.0` in **Orchestrator** and
watch sixteen systems update in order.

---

## 🏗️ Run it for real

### 🐳 Images

Build them — you need only Docker, and the console has nothing to install: no
npm, no bundler, no build step.

```bash
docker build -t qawk:local server/
docker build -t qawk-console:local console/
```

> 📦 **No images are published yet.** When you publish your own, give the server
> its version — it reports it at `/qawk/v1/info` and on the console's About page:
>
> ```bash
> V=0.1.0
> docker build --build-arg VERSION=$V -t <you>/qawk:$V server/
> docker build -t <you>/qawk-console:$V console/
> ```

### ▶️ Server, database and console

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
default types. **Back up two things:** the database, and `/var/lib/qawk`.

> ⚠️ **Set `QAWK_ADMIN_PASSWORD`.** Without it the administrator's password is
> `admin`. That administrator is never stored: it always works, which is how a new
> server is set up and how a lost password is fixed.

> 🔒 **Use HTTPS.** Devices send a bearer token on every poll. Give Qawk a
> certificate and it terminates TLS itself:
>
> ```bash
> -e QAWK_LISTEN=':8443' -e QAWK_TLS_CERT=/tls/cert.pem -e QAWK_TLS_KEY=/tls/key.pem
> ```
>
> `QAWK_TLS_CLIENT_CA` demands a certificate from the device too (mutual TLS), and
> `QAWK_REDIRECT_HTTP` points the old plain-HTTP address at the new one. A proxy in
> front is still fine — see
> [HTTPS](https://padovanl.github.io/qawk/install/#tls), which also shows how to
> make a certificate to test with.

📖 Compose, Kubernetes, every environment variable, users from a file, backup and
upgrade: **[Installing the server](https://padovanl.github.io/qawk/install/)**.

---

## 📟 Connect devices

Devices poll `http://<server>:8080/<tenant>/controller/v1/<controller id>`,
exactly as they poll hawkBit. With a **gateway token** they register themselves at
their first poll.

For **SWUpdate**, the suricatta section of `swupdate.cfg`:

```
suricatta: {
  url          = "https://updates.example.com";
  tenant       = "DEFAULT";
  id           = "device-0001";
  gatewaytoken = "a-random-token";
};
```

A device's attributes are what channels, centres and systems are built on —
`attribute.ring`, `attribute.centerid`, `attribute.device_type`,
`attribute.device`. Get them right and the rest arranges itself.

📖 **[Connecting devices](https://padovanl.github.io/qawk/devices/)**

---

## 🧪 No hardware? No problem

```bash
# 50 devices reporting ring=lab, polling every 30 s
demo/simulate.sh --url http://localhost:8080 --token <token> --fleet lab:50

# 16 systems -- a device1 with two device2 and a device3 -- in four centres
demo/simulate.sh --name centres --url http://localhost:8080 --token <token> --systems 16

demo/simulate.sh --list      # what is running
demo/simulate.sh --stop      # stop it all
```

They are not containers and there is no application inside them: one `qawk-sim`
process runs every device as its own client of the real device API. They
**simulate only the installation and the rollback** — no artifact is ever
downloaded, the install is a wait, and a failing device reports a rollback that
never had anything to undo. Registration, attributes, polling, the deployment
offered and every feedback message are real, which is all the server ever sees.
📖 [What is real and what is
pretended](https://padovanl.github.io/qawk/devices/#simwhat)

💥 **Make things fail on purpose** — because you cannot trust a safety mechanism
you have never seen fire:

| | |
|---|---|
| a module named `broken` | fails on every device → watch a release **halt** |
| `-- -fail-rate 0.1` | one deployment in ten fails at random |
| `-- -fail-where device=device-07,device_type=device3,set=2.0` | one component of one system → watch the **whole system roll back** |

⚡ **Load.** `qawk-load` measures how many polls a server holds:

```bash
docker run --rm --network host --ulimit nofile=65536:65536 --entrypoint qawk-load \
  qawk:local -url http://localhost:8080 -token <token> \
  -devices 10000 -interval 30s -ramp 30s -duration 180s -act
```

---

## 📖 Documentation

**[padovanl.github.io/qawk](https://padovanl.github.io/qawk/)**

| | |
|---|---|
| 🚀 [Get started](https://padovanl.github.io/qawk/start/) | The demo, Docker Hub, a build from source, or no Docker at all |
| 💡 [Concepts](https://padovanl.github.io/qawk/concepts/) | How the pieces fit, and a glossary |
| 🖱️ [Using the console](https://padovanl.github.io/qawk/console/) | **For whoever ships the update.** No command line anywhere in it |
| 🚦 [Channels and releases](https://padovanl.github.io/qawk/channels/) | Gates, approvals, waves, thresholds, freezes |
| 🏢 [Centres](https://padovanl.github.io/qawk/centres/) | Moving a place instead of a list of machines |
| 🧩 [The orchestrator](https://padovanl.github.io/qawk/orchestrator/) | Systems, topologies, manifests, rollback |
| 📟 [Connecting devices](https://padovanl.github.io/qawk/devices/) | SWUpdate, tokens, attributes, simulation |
| 🏗️ [Installing the server](https://padovanl.github.io/qawk/install/) | Docker, compose, Kubernetes, TLS, backup |
| 👥 [Users and audit](https://padovanl.github.io/qawk/users/) | Roles, tokens, what is recorded |
| 📊 [Operations](https://padovanl.github.io/qawk/operations/) | Metrics, alerts, scaling, troubleshooting |
| ⌨️ [API reference](https://padovanl.github.io/qawk/api/) | **91 endpoints**, each with the call in curl, Python, JavaScript, Go and PowerShell |
| 🐝 [hawkBit compatibility](https://padovanl.github.io/qawk/hawkbit/) | What is implemented, what differs and why, how to migrate |

To read the site locally, without publishing anything:

```bash
docs/serve.sh          # http://localhost:8099
```

The full server reference — every route, every rule, the numbers behind the
defaults — is [`server/README.md`](server/README.md).

---

## 🛠️ Develop and test

**Server** — Go 1.25:

```bash
cd server
go build ./... && go vet ./... && go test ./...
```

or without Go installed:
`docker run --rm -v "$PWD/server":/src -w /src golang:1.25-bookworm go test ./...`

**End-to-end**, against a **scratch** server (they change its configuration and
create data):

```bash
python3 server/test/contract.py     http://localhost:8080   # the hawkBit contract
python3 server/test/pipeline.py     http://localhost:8080   # channels and the pipeline
python3 server/test/rollouts.py     http://localhost:8080
python3 server/test/scheduled.py    http://localhost:8080
python3 server/test/systems.py      http://localhost:8080
python3 server/test/centres.py      http://localhost:8080
python3 server/test/orchestrated.py http://localhost:8080
python3 server/test/autopromote.py  http://localhost:8080
```

**Console** — Node 18+, for the tests only:

```bash
node console/test/smoke.mjs      # the module tree loads; no server needed
node console/test/compat.mjs     # every endpoint called is in the compatibility list
node console/test/fiql-live.mjs http://localhost:8080 admin changeme
```

After changing the console, `console/run-console.sh rebuild` restarts the demo's
console alone.

See [CONTRIBUTING.md](CONTRIBUTING.md).

---

## 🤝 Contributing

Bug fixes, documentation and tests need no ceremony — send them. For anything
larger, open an issue first: Qawk has strong opinions about how it behaves, and
a change that crosses one of them wants a conversation before it wants code.

| | |
|---|---|
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to run it, what the checks are, and what review will ask of you |
| [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) | Be decent. Argue about the code, not the person |
| [SECURITY.md](SECURITY.md) | Found a hole? **Do not open an issue** — report it privately |
| [CHANGELOG.md](CHANGELOG.md) | What changed, for someone deciding whether to upgrade |
| [LICENSING.md](LICENSING.md) | The licence, in full, and why |

Every source file carries an SPDX header, and CI refuses a pull request that
adds one without.

---

## 📁 Repository layout

```
server/                 Qawk
  cmd/qawk/             the server
  cmd/qawk-sim/         simulated devices
  cmd/qawk-load/        load generator
  internal/             APIs, service, store, users, metrics (server/README.md)
  reference/            hawkBit's API descriptions (EPL-2.0 — see its README)
  deploy/kubernetes/    manifests
  test/                 end-to-end tests
console/                the web console: index.html, js/, serve.py, test/
demo/                   start.sh, simulate.sh, seed.py, compose.yml
docs/                   the documentation site (GitHub Pages), docs/serve.sh
.github/                CI, the release workflow, issue and PR templates
```

---

## 📜 Licence

**[AGPL-3.0-or-later](LICENSE)** · Copyright © 2026 Luca Padovan

- ✅ **Run it on your own fleet** — modified or not, you owe nothing.
- ✅ **Change it**, and share the changes under the same licence.
- ❌ **Take it, close it, sell it as your own** — that is what this licence prevents.
- 💼 **Need other terms?** Open an issue. Commercial licences are available.

> 🔗 **If you change Qawk and let other people use it over a network**, they are
> entitled to *your* version's source. Set `QAWK_SOURCE_URL` to your own
> repository: it is answered by `/qawk/v1/info` and shown on the console's About
> page, which is how that offer reaches the people entitled to it.

Why the AGPL and not MIT, the Apache-2.0 alternative, the third-party components,
and the EPL-2.0 exception the embedded hawkBit files need: **[LICENSING.md](LICENSING.md)**
and [NOTICE](NOTICE).

*hawkBit is a trademark of the Eclipse Foundation; Mender is a trademark of
Northern.tech AS. Qawk is affiliated with neither.*
