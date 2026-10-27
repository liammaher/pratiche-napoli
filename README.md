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
npm run reports:aggregate               # within the hour: update each procedure's `reported` block
```

`reports:aggregate` reads the export and removes it: an export is used once, and only within an
hour of being made, since a report deleted or changed after it would still be in it as it was. It
first fetches origin's branches (not pull requests: anyone can open one, with a made-up block),
then reads every version of the blocks from the git history and the reflogs, and stops if it
can't (no git, a copy that isn't its own checkout, a shallow clone, a failed fetch, a git error),
since a version left out could give someone away. A version force-pushed away before this clone
fetched it can't be read: never rewrite a branch that had a `reported` block. It writes a `reported` block at the end of each procedure from the accepted reports
of the last 12 months: outcomes, answer times per channel, desk waits, amounts paid, how often
each listed document was asked for, and the maintainer's tips, rejection reasons and extra
documents. A procedure needs at least 3 reports, and every number in the block, outcome
and reason counts included, covers at least 3; so does what it leaves over beside the total it
belongs to (the count, a channel's count, the refusals), unless nothing is, so no figure is one
report's alone. Figures are medians, rounded more coarsely as they grow,
never a smallest or largest value. Every version of the block stays in the history, and adding
and subtracting versions gives the figures of the reports exactly the same versions cover as if
they were published on their own, so the rules hold in each such group too: new reports come in
3 or more at a time, reports published together leave together (when one is deleted or leaves the
window, the others go with it), and a figure is shown only if it holds in every group. `basis`
holds a random mark of each report, unrelated to its id or receipt, to tell which reports each
version covered. People's own words are never published. A changed block moves `updated`. The
page shows the figures under "Com'è andata ad altri", clearly as reports, not official sources.
The commands need `--project <id>` or `GCLOUD_PROJECT`, and your personal Google credentials
(`gcloud auth application-default login`), or `FIRESTORE_EMULATOR_HOST` to try them on the
emulator.

What 3 can't prevent: a count that covers a whole group (all 3 were refused, all 3 used PEC) is
true of each of them, so someone who knows a report is in that group, because they know when it
was sent, learns that much about it. Someone who sends reports of their own next to it can learn
more: with two at the extremes, a median is the third report's own figure. The review at `accept`
turns away reports that look like one person's, which helps against the second, not the first.
The privacy page says so.

## Situations

`situations/<id>.yaml` ([schema](contract/situation.schema.json)) groups the procedures one
situation involves, such as opening a bar or receiving a fine, with a few words on what each is
for. Situations only point at procedures: the page shows each procedure's own deadline, and every
fact and source stays on the procedure. `npm run validate` checks them too, and they have an
`updated` date like procedures.

## Filling a form

A form's `fields` say what goes in each box; a few optional keys let a tool fill it without
reading the notes (a person reading the notes is still fine):

- `map.template` writes a row's fields as the box wants them: `{identity.birth_comune}[
  ({identity.birth_country})]`. `[...]` is left out when a field in it is empty, `{...|date}`
  writes a date as DD/MM/YYYY, and in a `fallback` `{.civico}` is the civico of the place it picked.
  A `repeat` row's `columns` are templates too, over `*:` fields and `{relazione}`.
- `optional` lists the fields a row may leave empty; `required_if` says when one is needed after
  all (the stato estero of someone born abroad). Every other field must have a value, or the person
  is asked.
- `choices` makes a row boxes to tick, each with the values that tick it (`write_value` writes the
  value too, as on "altro ____").
- A deadline rule's `compute` dates it: `{ from: abitazione.data_inizio, days: 90 }`.

For a form with no fillable fields, `layouts/<procedure id>/<form id>.json`
([schema](contract/layout.schema.json)) says where each field goes on the PDF, for the form's exact
`sha256`: when the form changes, its layout no longer validates until it is measured again.
`npm run validate` checks that every field of the form has one box of the right kind.
A layout's optional `signatures` (rect, `date_rect`, `page`, `for`) place the signature line, for
a form with `signature_required`. A form's `signing` says, per channel, which ways the channel
takes the signature (`handwritten`, `digital`, `login`, `none`) and whether it wants an ID copy;
a signature step may carry `gate: sign` and stays `human_only`.

## Source monitor

`npm run check:sources` re-fetches the official pages and forms the procedures cite, asking the
offices' servers as little as possible, since some block an address that asks too much too fast:

- **When:** documents with a `sha256` every night, other pages on a fixed night of the week, plus
  any page that didn't answer or was refused last time, and any without a result from the last
  week (so the first run, or one after the saved state is lost, checks everything; `--all` always
  does). A refusal is a 403, a 429, or a 404 from a site whose home page is 404 too. A host whose
  last two answers were refusals (by the time of the request, so a site that blocks partway through
  a night counts; pages the archive saw gone, requests with no answer at all and server errors say
  nothing about the host either way) is asked one address a night, documents included, until it
  answers, plus any address it has never been asked or whose result is a week old; the rest of it
  counts as refused with it. That one address is the one asked longest ago, so it moves through
  them all, and a removed file can't keep a host that answers the rest from being checked. An
  address not asked keeps its last answer, and what was changed or not answering stays reported,
  marked as not asked.
- **How gently:** one request at a time per site (hosts of one domain, like `www.` and
  `static-www.comune.napoli.it`, are one site), with a pause between them. Each request carries the
  ETag and Last-Modified from the last check, so an unchanged file answers 304 without its body;
  once a week, on its own night, each document is downloaded and hashed whole anyway. A site that
  gave no answer at all to 2 addresses in a row (it accepts connections and then stalls) isn't
  asked the rest of the night, and after an hour nothing more is asked: those addresses count as
  not answering and are asked first the next night, and the run ends and saves what it saw. A 429
  is tried once more after a pause; if it is still a 429, the rest of that host isn't asked that
  night either, its home page included, and counts as refused; what it cut off is asked first the
  next night.
- **What it reports:** forms whose content no longer matches the recorded `sha256`; addresses that
  stopped answering; pages that now send you to the site's home or answer with an error page; and
  documents whose address now leads to a web page. Each comes with the procedures that cite it,
  and for pages that failed, what the Internet Archive's Wayback Machine last saw, a second opinion
  on whether a page is gone.
- **Listed but not reported on their own:** addresses whose certificate can't be verified (servers
  that don't send their full chain), and refusals (a 403, a 429, a 404 from a site whose home page
  is also 404), which mean the site is refusing the checker rather than that the page is gone
  (unless a 404's home is 404 and the Wayback Machine also last saw the page as 404: then it is
  reported as gone, every night until it answers). A page that has failed for 7 days or more in a
  row (refused, or not answering at all) and is still refused is reported, though: while the block
  lasts nothing on it is checked, forms included, so the issue stays open. The archive's answer is reused for a week, and kept when it can't be
  renewed.

The latest result per address is saved (`--state`, by default `.cache/sources-state.json`), so
each night's report covers the whole week. A run in which most sites gave no answer at all says
nothing (the problem is the checker's network) and changes nothing. The `Sources` workflow runs
it every night, keeps the saved results in the Actions cache, and keeps one issue, "Fonti da
ricontrollare", up to date: it comments when new addresses appear, and closes the issue when
everything is back as recorded.

## Layout

```
contract/procedure.schema.json   the procedure format (JSON Schema)
contract/layout.schema.json      where a form's fields go on its PDF
contract/fields.json             shared field-ID registry (e.g. identity.codice_fiscale), generated
contract/extensions.json         fields procedures need before the vault has them
procedures/<ente>/<slug>.yaml    one file per procedure
situations/<id>.yaml             the procedures of one situation
layouts/<id>/<form>.json         a form's layout, for one version of it
docs/discrepancies.md            wrong or contradictory official information we found
tools/                           validator, site builder and generators
tools/site/style.css             the site's stylesheet
```

Form fields map to IDs in `contract/fields.json`, never to personal values. The same IDs are
used by [personal-vault-italia](https://github.com/liammaher/personal-vault-italia), so an
agent with the person's consent can pre-fill a form, but the library never depends on it.
Every procedure carries the format's `schema_version`; the vault's pratica skill reads
version 0 and uses only the sources, deadline, channels and steps of any other, so raise it
(the `const` in `procedure.schema.json`) when a change would make an older reader misread an
entry, such as a new kind of map.

## Use

```sh
npm install
npm run validate        # check every procedure
npm run check:updated   # changed procedures and situations have their updated date bumped
npm run check:sources   # official pages and forms still answer and match
npm run check:vault-schema  # contract/vault-schema.json is the vault's current schema
npm run build           # build the site into site/
npm test                # tests
```

Regenerate the field registry after a vault schema change: save the vault's `schema.json`
(or `pvault schema --json > schema.json`), then `npm run gen:fields -- schema.json`. This saves
the schema as `contract/vault-schema.json` and rebuilds `contract/fields.json`; never edit
`fields.json` by hand (a test checks). The vault's credential words come with it, and the
validator refuses any field name that uses one, so the library never keeps its own list.
`npm run check:vault-schema` compares the saved copy with `schema.json` on the vault's main
branch; the `Vault schema` workflow runs it on every pull request and push to main, with the
`VAULT_SCHEMA_TOKEN` secret (read access to the vault repository's contents). It has no
scheduled run, so after a schema change in the vault alone, start it from the Actions tab
(or `gh workflow run vault-schema.yml`).

## Not legal advice

This is information to help you understand and prepare a procedure. Always check the cited
official source before acting. Content: CC BY-SA 4.0 (see LICENSE-CONTENT.md). Code: MIT.
