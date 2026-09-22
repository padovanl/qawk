# Third-party: Eclipse hawkBit's API descriptions

The three `hawkbit-1.1.0-*.json` files in this directory are **not Qawk's
work and not under Qawk's licence**. They are Eclipse hawkBit 1.1.0's own
OpenAPI descriptions and its recorded default configuration, and they are used
under the **Eclipse Public License 2.0** — the full text is in
[`LICENSE.hawkbit`](LICENSE.hawkbit).

| File | Is |
|---|---|
| `hawkbit-1.1.0-Management-API.json` | hawkBit's OpenAPI description of the Management API |
| `hawkbit-1.1.0-Direct-Device-Integration-API.json` | the same, for the device API |
| `hawkbit-1.1.0-defaults.json` | the tenant configuration a fresh hawkBit answers with |

Copyright the Eclipse hawkBit contributors. hawkBit is a trademark of the
Eclipse Foundation; Qawk is an independent implementation of the published
protocols and is not affiliated with the Eclipse Foundation.

## Why they are here

Qawk serves an OpenAPI document where hawkBit serves it, at
`/v3/api-docs/<group>`, built from these: the operation descriptions are
hawkBit's, and **only the operations Qawk really implements are listed**. The
console reads that document to decide whether the server it is talking to has
what it needs, so listing an operation that does not exist would make that
check lie.

`hawkbit-1.1.0-defaults.json` is what the contract test compares a fresh
Qawk's tenant configuration against, field by field.

## Licence interaction

Qawk is AGPL-3.0-or-later; these files are EPL-2.0, and they are embedded into
the server binary. The copyright holder of Qawk grants an additional
permission under AGPL section 7 allowing that combination — see
[`NOTICE`](../../NOTICE) at the root of the repository.

`embed.go` in this directory is Qawk's own code and is under Qawk's licence.
