# Security

## Reporting a vulnerability

**Please do not open a public issue.**

Report privately through GitHub's
[security advisories](https://github.com/padovanl/qawk/security/advisories/new),
which lets us discuss a fix before it is public.

Include what you can: what version, what you did, what happened, and what an
attacker gets out of it. A proof of concept helps and is not required.

You will get an acknowledgement within a week. This is a small project — there is
no team on rotation — so please allow a reasonable time for a fix before
publishing.

## What is in scope

Anything that lets someone:

- act as a device they are not, or take an update meant for another device;
- act as a user they are not, or do something their role does not permit;
- read artifacts, credentials or the audit log without authorisation;
- make the server serve a device the wrong software;
- lock out or crash the server remotely.

## What is not

These are documented behaviours, not vulnerabilities. Reporting them will get you
a link back to this list:

- **TLS is not built in.** Qawk is meant to run behind a proxy that terminates it.
  Plain HTTP exposing tokens is the deployment's problem, and is
  [documented](https://padovanl.github.io/qawk/install/#tls).
- **The default administrator password is `admin`.** It is documented in four
  places, and the server is meant to be started with `QAWK_ADMIN_PASSWORD` set.
- **A gateway token is a fleet-wide secret.** Anything holding one can register a
  device. That is what a gateway token is; use target tokens if it is not
  acceptable.
- **`/metrics` is open unless `QAWK_METRICS_TOKEN` is set.** Documented, and
  deliberate for a scraper on an internal network.
- **`/qawk/v1/info` needs no credentials.** It exists so a console can find out
  what it is talking to before anyone signs in. It exposes the version and the
  feature list, nothing else.
- **The audit log is not tamper-proof.** It is a table in the same database as
  everything else. Ship it out if you need evidence rather than a record.
- **One tenant per server.** hawkBit's multi-tenant isolation is not implemented,
  and is not claimed anywhere.

## What Qawk does on its own behalf

- Passwords: **PBKDF2-SHA256, 600,000 iterations**. A check costs about half a
  second on purpose; a successful one is cached for thirty seconds, because the
  console sends credentials with every request.
- API tokens: only the **SHA-256** is stored. The token is shown once. A token
  acts with its owner's permissions *at the time of use*, so revoking a role
  revokes the token's access with it.
- Every change and every refused sign-in is in the audit log, with the address.
- The server runs as an unprivileged user in its image, opens one port and writes
  one directory.
- Uploaded artifacts are checked against the hashes the uploader declared before
  they are accepted.

## Supported versions

The latest release. This project is young; there is no long-term support branch
yet.
