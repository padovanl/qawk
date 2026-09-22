# Licensing

Qawk is **AGPL-3.0-or-later**. Copyright © 2026 Luca Padovan.

This file explains what that means in practice, why it was chosen over the
alternatives, and what a company that cannot use the AGPL should do.

---

## The short version

| You want to | You may |
|---|---|
| Run Qawk to update your own devices | Yes. No obligation of any kind. |
| Change it and run your changed version internally | Yes. Still no obligation. |
| Give a copy to someone else | Yes — with the source, under the AGPL. |
| Run a **modified** Qawk as a service others reach over a network | Yes — and you must offer those users the source of your modified version. |
| Take Qawk, close the source, and sell it as your own product | **No.** That is what this licence prevents. |
| Do any of the above under different terms | Ask. See [commercial licensing](#commercial-licensing). |

The attribution in `NOTICE`, in the file headers and on the console's About page
is part of the licence. Removing it is not permitted.

---

## Why the AGPL and not MIT

MIT permits anyone to take the work, close it, rebrand it and sell it, and the
only thing they owe you is a copyright line in a file nobody opens. For a
library that is often the right trade. For a finished server that took years to
get right, it means the author's work can become someone else's product with
no credit that anyone ever sees and nothing given back.

The AGPL keeps three things that matter here:

1. **The name stays attached.** Every copy, and every derived work, carries the
   copyright and the notice.
2. **Improvements come back.** Anyone who distributes a modified Qawk —
   including anyone who *runs* a modified Qawk as a network service, which is
   exactly how an update server is used — has to make that source available.
   Section 13 is why the AGPL and not the plain GPL.
3. **It stays open.** Nobody can make a closed fork the better one.

None of this is aimed at the people it is meant for. A company that installs
Qawk and updates its own fleet with it has no obligations whatsoever, whether
or not they modify it, because they are not conveying it to anyone.

## Why not Apache-2.0

Apache-2.0 was the serious alternative, and it has the strongest *attribution*
requirement of the permissive licences: section 4(d) makes downstream
distributors carry your `NOTICE`, and 4(b) makes them state their changes.

It was not chosen because it still permits the closed, rebranded fork — the
exact outcome this project wants to prevent. But it is a defensible choice, and
switching is easy for as long as the copyright is held by one person:

```
Replace LICENSE with the Apache-2.0 text, keep NOTICE (Apache-2.0 gives it
force), change the SPDX headers from AGPL-3.0-or-later to Apache-2.0, and
drop the section 7 exception below, which Apache-2.0 does not need.
```

Do it before accepting contributions from other people, not after — see
[Contributions](#contributions).

## Why not a source-available licence

BUSL, the Commons Clause and similar are not open-source licences. They would
bar the very people this is for — a customer who wants to run it, change it and
be sure it will still be theirs in five years — and they would make Qawk
ineligible for most of the places open-source software is found. The AGPL is
aggressive enough to protect the work while remaining genuinely open source.

---

## The Eclipse Public License exception

`server/reference/` contains three files that are **not Qawk's work**: Eclipse
hawkBit's own OpenAPI descriptions and its recorded default configuration,
under the **EPL-2.0**. Qawk embeds them in order to serve, at `/v3/api-docs`,
a document listing exactly the operations it implements.

EPL-2.0 and the GPL family are generally held to be incompatible, so combining
them into one binary needs saying out loud rather than hoping. As sole
copyright holder, the author grants an **additional permission under AGPL
section 7** allowing that specific combination. The wording is in
[`NOTICE`](NOTICE); the files and their licence are described in
[`server/reference/README.md`](server/reference/README.md).

If you would rather not rely on an exception at all, the files can be removed:
the cost is the `/v3/api-docs` endpoints and the contract test's comparison of
default tenant configuration.

---

## Third-party components

All of them are AGPL-compatible. The full list, with copyright holders, is in
[`NOTICE`](NOTICE).

| Where | What | Licence |
|---|---|---|
| `server/reference/*.json` | hawkBit API descriptions | EPL-2.0 (see above) |
| `server/go.mod` | chi, pgx | MIT, BSD-3-Clause |
| `server/go.mod` | OpenTelemetry, gRPC, protobuf | Apache-2.0 |
| `console/js/vendor/` | react, reactflow, dagre, gridstack, Sortable, js-yaml | MIT |
| `console/fonts/` | Inter, JetBrains Mono | SIL OFL 1.1 |

Fonts under the OFL are distributed under the OFL, not the AGPL; the OFL
permits bundling them with software under any licence.

---

## Commercial licensing

The AGPL does not suit every company. Some cannot accept section 13 for a
service they operate; some want to build Qawk into a closed product.

Because the copyright is held by one person, Qawk can be licensed on other
terms to anyone who asks. Open an issue, or contact the author.

This is deliberate: the AGPL is the default so the work stays open and
attributed, and a commercial licence exists so that being open does not mean
being unpaid.

---

## Contributions

By opening a pull request you agree that your contribution is licensed under
AGPL-3.0-or-later, and you keep your copyright in it.

**Note that this means commercial relicensing stops being possible** the moment
a contribution from someone else is merged without a separate agreement, since
relicensing needs every copyright holder's permission. If dual licensing is
going to matter, put a CLA or a DCO-plus-relicensing-grant in place **before**
merging the first outside contribution. It cannot be arranged retroactively
except by asking every contributor individually.

---

## Applying the licence to a new file

Go, and anything else with `//` comments:

```go
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Luca Padovan
```

Shell, Python, YAML:

```sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 Luca Padovan
```
