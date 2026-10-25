# Contributing a procedure

1. One file per procedure: `procedures/<ente>/<slug>.yaml`, with `id` equal to that path
   (without `.yaml`). Lower-case words joined by hyphens.
2. **No personal data, ever.** No names, codici fiscali, addresses, IBANs, amounts or dates
   that belong to a person. Form fields map to IDs in `contract/fields.json`. If a form asks
   for something not in the registry, use `{ ask: "..." }` and propose the field.
3. **Official sources first.** Cite the ente's own page, regulation, decision or form. Third-
   party guides are only for finding official pages.
4. **Mark every claim honestly.** `verified` needs a `source`. If you believe something but
   haven't checked it, write `unverified`. If sources disagree, write `disputed` and say how.
5. **Never estimate penalties or interest.** Point to the official calculator or the desk.
6. **Steps that only a person can do** (sign, pay, send, swear, be present) get
   `human_only: true`.
7. Set `verification` to the level you actually reached, and add a `run_log` line when a real
   case used the procedure (what happened, no personal values).
8. Run `npm run validate` and `npm test` before opening a pull request.
