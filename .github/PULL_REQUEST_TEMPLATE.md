## What this changes

<!-- One or two sentences. What is different afterwards, for whoever uses it. -->

## Why

<!-- The problem it solves. If there is an issue, link it. If the reason is
     something you measured or hit in production, that is the most useful
     sentence in this whole template -- put it here. -->

## Checks

- [ ] `cd server && go build ./... && go vet ./... && go test ./...`
- [ ] `gofmt -l server` prints nothing
- [ ] `node console/test/smoke.mjs` and `node console/test/compat.mjs` pass
- [ ] `node docs/check.mjs` and `python3 docs/check-links.py` pass (if docs changed)
- [ ] `python3 server/test/contract.py <a scratch server>` passes (if the
      hawkBit surface is touched)

## The things that usually come up in review

- [ ] New endpoints are under `/qawk/v1`, not added to hawkBit's API
- [ ] Schema changes are a **new** migration, never an edit to an existing one
- [ ] New files carry the SPDX header
- [ ] The comments say *why*, not *what* — especially what went wrong before
- [ ] There is a test that would have caught the bug being fixed
- [ ] The documentation is updated if behaviour changed

<!-- By opening this you agree your contribution is licensed under
     AGPL-3.0-or-later. You keep your copyright in it. See LICENSING.md. -->
