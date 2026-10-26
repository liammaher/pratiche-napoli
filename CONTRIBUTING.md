# Contributing a procedure

1. One file per procedure: `procedures/<ente>/<slug>.yaml`, with `id` equal to that path
   (without `.yaml`). Lower-case words joined by hyphens.
2. **No personal data, ever.** No names, codici fiscali, addresses, IBANs, amounts or dates
   that belong to a person. Form fields map to IDs in `contract/fields.json`. If a form asks
   for something not in the registry, use `{ ask: "..." }` and propose the field. A list of
   family members (conviventi, componenti del nucleo) is `{ repeat: famiglia, fields: [...] }`:
   one row per member of the stato di famiglia, each from that member's `*:category.field`
   (`*:identity.codice_fiscale`). Never name a member's slug.

   People a business has (procuratore, preposto, soci, responsabile tecnico) are picked by
   their `ruolo`, one of the values in `procedure.schema.json`'s `$defs/ruolo`:
   `{ party: { ruolo: procuratore }, direct: identity.codice_fiscale }` reads that person's
   field (also with `concat` or `fallback`; fields without a prefix), and
   `{ repeat: { ruolo: [socio, amministratore], except: dichiarante }, fields: [...] }` fills one
   row per such person. A business procedure says who signs with
   `dichiarante: { ruolo: [titolare, legale_rappresentante] }`; then `identity.*`, `residenza.*`,
   the other categories about a person and `ruolo.*` are the dichiarante's, in the forms and in
   `records`, while `business.*` and `locale.*` stay the business's. In a personal vault that is the owner; in a business vault,
   the person with that ruolo. Someone who is only the other side of one deal (the cedente, the
   subentrante) stays an `ask`.
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
   `human_only: true`.
8. **Data the procedure produces** (a codice contribuente, a REA number) goes in `records`:
   one registry field each, and `from`, the document or message it is read from. List only
   fields the registry has; propose the others.
9. Set `verification` to the level you actually reached, and add a `run_log` line when a real
   case used the procedure (what happened, no personal values).
10. **Set `updated` to today whenever you change a procedure**, re-checking a source or
   logging a run included (comments and layout don't count). It is the page's "last updated"
   date on the site, in the sitemap and in the JSON, so it must never lag behind the content.
   `npm run check:updated` compares your branch with `origin/main` and fails if you forgot;
   CI runs it on every pull request.
11. Run `npm run validate`, `npm run check:updated` and `npm test` before opening a pull
    request.

## Situations

A situation (`situations/<id>.yaml`) lists the procedures someone meets in one situation. Its
`when` says in a few words what each procedure is for there, and nothing more: no deadlines,
amounts or rules, which belong to the procedure, with its sources. Add a procedure to every
situation it belongs to, and keep `updated` current as for procedures.
