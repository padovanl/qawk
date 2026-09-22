# Contributing to Qawk

Thanks for looking. This is a small project with a clear shape, and these notes
are here so a pull request does not bounce for something avoidable.

## Before anything large

**Open an issue first** for a new feature or a change to how something behaves.
Qawk has strong opinions — that a device with an open action is never overtaken,
that a system rolls back as a whole, that hawkBit's API is never changed to carry
something of Qawk's — and a change that crosses one of those needs a conversation
before it needs code.

Bug fixes, documentation and tests need no ceremony. Send them.

## Licence

By opening a pull request you agree your contribution is licensed under
**AGPL-3.0-or-later**. You keep your copyright in it. New files get:

```go
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 <you>
```

See [LICENSING.md](LICENSING.md).

## Running it

```bash
demo/start.sh            # a server, a console and ~270 simulated devices
demo/start.sh down       # remove everything
```

## Before you push

```bash
cd server
go build ./... && go vet ./... && go test ./...
gofmt -l .               # must print nothing
```

End-to-end tests want a **scratch** server — they change its configuration and
create data. Never point them at anything real:

```bash
python3 server/test/contract.py     http://localhost:8080   # the hawkBit contract
python3 server/test/pipeline.py     http://localhost:8080
python3 server/test/orchestrated.py http://localhost:8080
# ... and the others in server/test/
```

Console:

```bash
node console/test/smoke.mjs
node console/test/compat.mjs
```

Documentation site:

```bash
docs/serve.sh            # http://localhost:8099
```

## Things that will be asked of you

**The contract test must pass.** It replays a flow recorded from a real hawkBit
1.1.0 and compares every answer field by field. If your change makes it fail, it
changes hawkBit compatibility, and that needs to be deliberate, listed in the
test's allow-list of deviations, with the reason — see
[where Qawk differs](https://padovanl.github.io/qawk/hawkbit/#differences).

**New endpoints go under `/qawk/v1`.** hawkBit's API is never extended to carry
something of Qawk's. A client written for hawkBit must not see anything new.

**Schema changes are a new migration**, never an edit to an old one. Migrations go
forward only; there are no down-migrations, on purpose.

**Say why in the comment, not what.** The code says what it does. The comments in
this repository say what went wrong before, what was measured, and why a thing is
the way it is — that is the part that cannot be recovered from reading the code
again in a year. Match that.

**Commit messages** are a one-line summary that would make sense in a changelog,
then blank line, then what the change is for. Present tense, no ticket numbers.

**Add the test that would have caught it.** A bug fix with no test is a bug fix
that comes back.

## Reporting a security problem

Do not open a public issue. See [SECURITY.md](SECURITY.md).
