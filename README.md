# pratiche-napoli

**Ogni procedura burocratica che un'impresa di Napoli può incontrare, descritta in modo
chiaro, verificato e leggibile anche dalle intelligenze artificiali.**

An open, verified, machine-readable library of the bureaucratic procedures a Naples
micro-business can face, across every authority (Comune, ASL, Camera di Commercio, INPS,
Agenzia delle Entrate…). Each procedure says who it applies to, the deadline, the channels,
the documents and forms, the exact steps, and which steps only a person can do. Each records
its official sources and how far it has been verified.

## Verification levels

| Level | Meaning |
|---|---|
| L0 | Draft |
| L1 | Desk-checked against official sources |
| L2 | Confirmed by the office (email, PEC or at the desk) |
| L3 | A real filing went through using it |

Individual claims (a deadline, a fee) also carry `verified`, `unverified` or `disputed`, so
an unconfirmed detail is never presented as fact.

## Layout

```
contract/procedure.schema.json   the procedure format (JSON Schema)
contract/fields.json             shared field-ID registry (e.g. identity.codice_fiscale), generated
contract/extensions.json         fields procedures need before the vault has them
procedures/<ente>/<slug>.yaml    one file per procedure
docs/discrepancies.md            wrong or contradictory official information we found
tools/                           validator and generators
```

Form fields map to IDs in `contract/fields.json`, never to personal values. The same IDs are
used by [personal-vault-italia](https://github.com/liammaher/personal-vault-italia), so an
agent with the person's consent can pre-fill a form, but the library never depends on it.

## Use

```sh
npm install
npm run validate   # check every procedure
npm test           # validator tests
```

Regenerate the field registry after a vault schema change: `pvault schema --json > schema.json`,
then `npm run gen:fields -- schema.json`. This saves the schema as `contract/vault-schema.json`
and rebuilds `contract/fields.json`; never edit `fields.json` by hand (a test checks).

## Not legal advice

This is information to help you understand and prepare a procedure. Always check the cited
official source before acting. Content: CC BY-SA 4.0 (see LICENSE-CONTENT.md). Code: MIT.
