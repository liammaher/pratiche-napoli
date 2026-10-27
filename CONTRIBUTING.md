# Contributing a procedure

1. One file per procedure: `procedures/<ente>/<slug>.yaml`, with `id` equal to that path
   (without `.yaml`). Lower-case words joined by hyphens.
2. **No personal data, ever.** No names, codici fiscali, addresses, IBANs, amounts or dates
   that belong to a person. Form fields map to IDs in `contract/fields.json`. If a form asks
   for something not in the registry, use `{ ask: "..." }` and propose the field. A list of
   family members (conviventi, componenti del nucleo) is `{ repeat: famiglia, fields: [...] }`:
   one row per member of the stato di famiglia, each from that member's `*:category.field`
   (`*:identity.codice_fiscale`). Never name a member's slug. A second unit of something the vault
   keeps one of (a second premises) is its numbered copy, `locale2.*`, with the same fields and
   rules; a row for it says in its `notes` that it is filled only when the vault has one. Categories
   marked `one_only` in the registry (`famiglia`, `ruolo`) have no copies.

   People a business has (procuratore, preposto, soci, responsabile tecnico) are picked by
   their `ruolo`, one of the vault's `ruolo.tipo` values (`procedure.schema.json`'s `$defs/ruolo`):
   `{ party: { ruolo: procuratore }, direct: identity.codice_fiscale }` reads that person's
   field (also with `concat` or `fallback`; fields without a prefix), and
   `{ repeat: { ruolo: [socio, amministratore], except: dichiarante }, fields: [...] }` fills one
   row per such person. A business procedure (`business` in its `audience`; only such a one) says who signs with
   `dichiarante: { ruolo: [titolare, legale_rappresentante] }` (only those two: `$defs/signer`;
   a procuratore is a `party` of its own); then `identity.*`, `residenza.*`,
   the other categories about a person and `ruolo.*` are the dichiarante's, in the forms and in
   `records`, while `business.*` and `locale.*` stay the business's. In a personal vault that is the owner; in a business vault,
   the person with that ruolo. Someone who is only the other side of one deal (the cedente, the
   subentrante) stays an `ask`. `procura.*` is a procura a person gave the business, so `party`
   and `repeat: { ruolo }` read it only from ruolo `cliente`: a procuratore holds the business's
   procura, not one they gave it. (`repeat: famiglia` may read it: a family member's delega.)

   A box that applies only in some cases (the vehicle is a company's, a procura is used) is
   settled first by an `ask` row, and the rows that depend on it say so in their `notes`: a
   vault that has a business's data doesn't make every pratica the business's. Likewise, a
   `fallback` must not reach a field that may belong to something else (a business's partita
   IVA or PEC on a personal pratica), first or not: read only the person's own field, or `ask`.
   Contacts (PEC, e-mail) are the person's own, and the business's only where the pratica is the
   business's. An address is taken whole from one place (residenza or domicilio, the business's
   premises, its registered office or one's home), never a box from each: say so on every row
   of it, and that a part it lacks is asked (or, like an interno it doesn't have, left empty),
   never taken from the other. The validator refuses a `concat` that joins two of these places,
   a `fallback` between a person's address and the business's, and one from domicilio to
   residenza without notes. A field that holds
   a list (`ruolo.tipo`) fills a box that takes one value only with notes saying which one; the
   dichiarante's "in qualità di", `fallback: [business.qualita_dichiarante, ruolo.tipo]`, is the
   one the pratica skill already reads as the role they sign in.
3. **Official sources first.** Cite the ente's own page, regulation, decision or form. Third-
   party guides are only for finding official pages.
4. **Mark every claim honestly.** `verified` needs a `source`. If you believe something but
   haven't checked it, write `unverified`. If sources disagree, write `disputed` and say how.
5. **Never estimate penalties or interest.** Point to the official calculator or the desk.
   The same goes for `cost`, `duration` and `appointment`, which open the page in its
   "In breve" box: fill them only from an official source, and leave them out rather
   than guess. `cost` is what doing the procedure costs (fees, bolli), not the tax it
   concerns.
6. **Title it the way people search.** `headline` is the page title in plain words, a
   question or an action ("Come iscriversi alla TARI a Napoli dopo un trasloco"); `title`
   stays the official name. `aka` lists the everyday names people type ("tassa sulla
   spazzatura").
7. **Steps that only a person can do** (sign, pay, send, swear, be present) get
   `human_only: true`. **Map every route end to end**: where a step is done differently on a
   channel (send by PEC, by raccomandata A/R, at the desk), write one step per channel with
   `channel: [pec]` and say exactly where it goes and what to keep as proof. A desk needs an
   address, a `url` that finds it, or `office: { list, from }` when it depends on where the
   person lives: the list of the service that does it (`offices/<list>.json`; add one, with
   an office for every value and the page each comes from, when no list is that service). A form's
   `signing` lists only what differs from `contract/signing.json`.
8. **Say what a box needs, not only in notes.** When a box takes several fields, give the row a
   `template` (a fallback reads its place's other parts as `{.civico}`); mark fields that may be
   empty with `optional`, and with `required_if` when they are needed in some cases; make a row of
   boxes to tick `choices`, and a row that applies only after a given answer `when`; give a
   deadline that runs from a date the vault keeps a `compute`. A form can get a layout in
   `layouts/` (see the README), measured on the form with the `sha256` the procedure records.
9. **Data the procedure produces** (a codice contribuente, a REA number) goes in `records`:
   one registry field each, and `from`, the document or message it is read from. List only
   fields the registry has; propose the others.
10. Set `verification` to the level you actually reached, and add a `run_log` line when a real
   case used the procedure (what happened, no personal values).
11. **Set `updated` to today whenever you change a procedure**, re-checking a source or
   logging a run included (comments and layout don't count). It is the page's "last updated"
   date on the site, in the sitemap and in the JSON, so it must never lag behind the content.
   `npm run check:updated` compares your branch with `origin/main` and fails if you forgot;
   CI runs it on every pull request.
12. Run `npm run validate`, `npm run check:updated` and `npm test` before opening a pull
    request.

## Situations

A situation (`situations/<id>.yaml`) lists the procedures someone meets in one situation. Its
`when` says in a few words what each procedure is for there, and nothing more: no deadlines,
amounts or rules, which belong to the procedure, with its sources. Add a procedure to every
situation it belongs to, and keep `updated` current as for procedures.
