# Qawk

An update server for device fleets that speaks
[Eclipse hawkBit](https://eclipse.dev/hawkbit/)'s protocols, and a console for
it.

- **server/** — Qawk, in Go on PostgreSQL. Devices (SWUpdate's suricatta, or
  any hawkBit DDI client) and tools written for hawkBit's Management API work
  with it unchanged. On top it adds fleets and a release pipeline
  (dev → beta → prod), systems updated as a whole after Mender Orchestrator,
  users and roles, an audit log, metrics and OpenTelemetry.
  See [server/README.md](server/README.md).
- **console/** — a web console, plain JavaScript with no build step, served by
  a small Python proxy. It works with Qawk and with a stock hawkBit 1.1.0.
- **demo/** — everything on docker, with simulated devices and sample data.

## Try it

Needs docker and python3.

```bash
demo/start.sh
```

Then open http://localhost:8090 and sign in as `admin` / `changeme`. Simulated
devices register within a minute; `dev` is given a first release to watch.
`demo/start.sh down` removes it all. The script's header lists what can be
changed (ports, passwords, how many devices, a users file).

## Images

```bash
docker build -t qawk:local server/
docker build -t qawk-console:local console/
```

The server's image also holds `qawk-sim` (simulated devices) and `qawk-load`
(a load generator).

## License

MIT — see [LICENSE](LICENSE).
