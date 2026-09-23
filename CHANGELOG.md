# Changelog

What changed, for someone deciding whether to upgrade. Notable changes only —
`git log` has the rest.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until 1.0 the minor number may carry a breaking change; when it does, it says
so here in bold.

## [Unreleased]

The first public release is being prepared. Everything below is in `main` and
has not been tagged yet.

### Added

- **HTTPS, without a proxy.** `QAWK_TLS_CERT` and `QAWK_TLS_KEY` make the
  server terminate TLS itself, TLS 1.2 as the floor. `QAWK_TLS_CLIENT_CA`
  demands a verified client certificate from every device (mutual TLS).
  `QAWK_REDIRECT_HTTP` answers the old plain-HTTP address with a 308.
- **CORS, off by default.** `QAWK_CORS_ORIGINS` lets a browser front end of
  your own read the API's answers.
- **Retrying one system.** `POST /qawk/v1/systemdeployments/{id}/runs/{id}/retry`
  takes a system that rolled back, or was skipped, again — from where the
  system is now, with that deployment's own manifest. In the console: **take
  again**.
- **Centres, in order.** A channel can name the centres its orchestrator takes
  and the order it takes them in (`orchestrator.centres`).
- **Simulated devices in centres.** `qawk-sim`'s `-fleet` takes
  `:centers=N` or `:centers=A-B`, and shares those centres with `-system` —
  because a centre holds both kinds of machine.
- **The source offer the AGPL requires.** `QAWK_SOURCE_URL`, answered by
  `/qawk/v1/info` and shown on the console's About page.
- **A documentation site**, at [padovanl.github.io/qawk](https://padovanl.github.io/qawk/),
  with an API reference covering 91 endpoints in five languages.

### Fixed

- **A channel's orchestrator now follows the channel.** The systems were
  chosen once, when the release started, so a centre moved into a channel
  afterwards got nothing at all: its standalone devices took the channel's
  set, and its systems were left out of both the orchestrator and the
  channel's delivery. They waited for ever, silently. The orchestrator now
  asks again on every pass, gives up systems that left, and reopens a
  deployment — and its release — when systems arrive.
- **Qawk's own errors say `qawk`.** A 404 for a channel claimed
  `org.eclipse.hawkbit.repository.exception.EntityNotFoundException`, a class
  that never produced one. The shape is unchanged; only the names moved.
- The sixteenth device operation (an artifact's `.MD5SUM`) was served but not
  declared, so no generated client could ask for it.
- `GET /rest/v1/rollouts/{id}` and `POST /rest/v1/rollouts/{id}/deny` were
  missing from the console's compatibility list, so it could not warn when a
  server lacked them.
- A Mender manifest whose component names no `update_strategy` now imports
  into the first order instead of being refused, and importing the same
  manifest twice updates it.

[Unreleased]: https://github.com/padovanl/qawk/commits/main
