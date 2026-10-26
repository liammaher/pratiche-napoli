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

## Last updated

Every procedure has an `updated` date: the last day anything in it changed. The validator
checks that nothing in the file (a verification, a source check, a run) is newer than it, and
`npm run check:updated` fails when a procedure changed on a branch without its date moving.
The site shows the date on each page and publishes it in the structured data, the sitemap
(`lastmod`) and the JSON; the library's date is that of its newest procedure.

## Site and JSON

`npm run build` writes a static site to `site/`, ready for any static host:

| Path | What |
|---|---|
| `/<id>/` | one page per procedure, e.g. `/napoli/comune/tari-iscrizione-uso-abitativo/`, titled with its `headline` and opening with an "In breve" box (deadline, cost, time, online or not, appointment, documents) |
| `/<id>.json` | the same procedure as JSON, exactly as in its YAML file |
| `/<ente folder>/` | the procedures of one ente, e.g. `/napoli/comune/` |
| `/situazioni/<id>/` | the procedures of one situation, e.g. `/situazioni/apro-bar-ristorante/` |
| `/come-lavoriamo/`, `/aggiornamenti/` | how the library is written and verified; the 50 latest changes |
| `/procedures.json` | index of all procedures with their `updated` dates, and the library's |
| `/contract/*.json` | the procedure schema and field registry |
| `/sitemap.xml`, `/robots.txt`, `/llms.txt` | for search engines and AI assistants |

Set `SITE_URL` to the public address (default `https://liammaher.github.io/pratiche-napoli`);
it is used for canonical links, the sitemap and the JSON index. Links between pages are
relative. The build refuses a library that doesn't validate.

Each procedure page can end with a "Racconta com'è andata" form, whose reports go to the
private backend in [`reports/`](reports/README.md). It appears only when the build gets both
`REPORTS_URL` (the deployed `submitReport` function) and `CONTACT_EMAIL` (the address the
`/privacy/` page gives for data requests); with one and not the other the build stops. The
form works without JavaScript too: the backend answers a plain post with a redirect to
`/grazie/`.

## What people reported

People who did a procedure can tell us how it went (the form on each page, or an assistant
with their consent); see [`reports/`](reports/README.md). Reports are private. A maintainer
reviews them and publishes only aggregates:

```sh
npm run reports -- list [--accepted]    # pending (or accepted) reports, by procedure
npm run reports -- show <id>            # one report; find <email> gives someone's ids
npm run reports -- accept <id> [--tip "…"] [--rejection-reason "…"] [--extra-document "…"]
                                        # again to change them; "" removes one
npm run reports -- reject <id>          # or: delete <id>, on a request to erase it
npm run reports -- export               # accepted reports to reports-cache.json (never commit it)
npm run reports:aggregate               # update each procedure's `reported` block
```

`reports:aggregate` writes a `reported` block at the end of each procedure from the accepted
reports of the last 12 months: outcomes, answer times per channel, desk waits, amounts paid,
how often each listed document was asked for, and the maintainer's tips, rejection reasons and
extra documents. A procedure needs at least 3 reports, and every number in the block, outcome
and reason counts included, covers at least 3; so does what it leaves over beside the total it
belongs to (the count, a channel's count, the refusals), unless nothing is, so no one person's
result can be singled out or worked out. Figures are medians, rounded more coarsely as they grow,
never a smallest or largest value. Since every version of the block stays in the history, a
block only changes when, against every earlier version, at least 3 reports came in or dropped
out (`basis` holds a fingerprint of each report, to tell); a block that can't change for 90
days is removed until it can. People's own words are never published. A changed block moves
`updated`. The page shows the figures under "Com'è andata ad altri", clearly as reports, not
official sources. The commands need `--project <id>` or `GCLOUD_PROJECT`, and your personal
Google credentials (`gcloud auth application-default login`), or `FIRESTORE_EMULATOR_HOST` to
try them on the emulator.

## Situations

`situations/<id>.yaml` ([schema](contract/situation.schema.json)) groups the procedures one
situation involves, such as opening a bar or receiving a fine, with a few words on what each is
for. Situations only point at procedures: the page shows each procedure's own deadline, and every
fact and source stays on the procedure. `npm run validate` checks them too, and they have an
`updated` date like procedures.

## Source monitor

`npm run check:sources` re-fetches the official pages and forms the procedures cite, asking the
offices' servers as little as possible, since some block an address that asks too much too fast:
documents with a `sha256` every night and other pages on a fixed night of the week, plus any page
without a result from the last week, so the first run (or one after the saved state is lost) checks
everything (`--all` always does); one request at a time per site with a pause between them; and each request carries the
ETag and Last-Modified from the last check, so an unchanged file answers 304 without its body. The
latest result per address is saved (`--state`, by default `.cache/sources-state.json`), so each
night's report covers the whole week. For pages that failed, the report adds what the Internet
Archive's Wayback Machine last saw, a second opinion on whether a page is gone. It reports forms whose content no longer matches the recorded `sha256`,
and addresses that stopped answering, with the procedures that cite them. Two kinds are listed but
don't make a report on their own: addresses whose certificate can't be verified (servers that
don't send their full chain), and 404s from a site whose home page is also 404, which means the
site is refusing the checker rather than that the page is gone. The `Sources`
workflow runs it every night, keeps the saved results in the Actions cache, and keeps one issue,
"Fonti da ricontrollare", up to date, closing it when everything is back as recorded.

## Layout

```
contract/procedure.schema.json   the procedure format (JSON Schema)
contract/fields.json             shared field-ID registry (e.g. identity.codice_fiscale), generated
contract/extensions.json         fields procedures need before the vault has them
procedures/<ente>/<slug>.yaml    one file per procedure
situations/<id>.yaml             the procedures of one situation
docs/discrepancies.md            wrong or contradictory official information we found
tools/                           validator, site builder and generators
tools/site/style.css             the site's stylesheet
```

Form fields map to IDs in `contract/fields.json`, never to personal values. The same IDs are
used by [personal-vault-italia](https://github.com/liammaher/personal-vault-italia), so an
agent with the person's consent can pre-fill a form, but the library never depends on it.

## Use

```sh
npm install
npm run validate        # check every procedure
npm run check:updated   # changed procedures and situations have their updated date bumped
npm run check:sources   # official pages and forms still answer and match
npm run build           # build the site into site/
npm test                # tests
```

Regenerate the field registry after a vault schema change: `pvault schema --json > schema.json`,
then `npm run gen:fields -- schema.json`. This saves the schema as `contract/vault-schema.json`
and rebuilds `contract/fields.json`; never edit `fields.json` by hand (a test checks).

## Not legal advice

This is information to help you understand and prepare a procedure. Always check the cited
official source before acting. Content: CC BY-SA 4.0 (see LICENSE-CONTENT.md). Code: MIT.
