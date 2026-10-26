# Reports backend

People who did a procedure can tell us how it went. Their reports go to one
HTTPS function, `submitReport`, in Firebase (region `europe-west8`, Milan). It
checks each report against [`contract/report.schema.json`](../contract/report.schema.json),
cuts out codici fiscali and IBANs, and stores it in Firestore as `pending`. Reports
are private: only aggregates (at least 3 reports) and tips rewritten by a
maintainer are ever published, never a report as written.

## What it stores

- `reports/{id}`: the report's fields, plus `status: "pending"`, `received_at`,
  `schema_version: 0` and `pii_redacted` (true when personal data was replaced
  with `[rimosso]`, including codes with the usual slips: lower case, 0 for O,
  other groupings, a character missing or extra). Deleted once its month leaves the
  12-month window the figures use, whatever its status (`expires_at`, Firestore TTL);
  a month already outside the window is refused.
- `contacts/{id}`: `contact_email`, only when the person ticked `consent_contact`,
  with the same id as the report. Deleted after 12 months (`expires_at`, Firestore TTL).
- `ratelimits/{hash}`: a count per hour per salted SHA-256 of the sender's IP (for
  IPv6, its /64), so at most 10 stored reports an hour come from one address.
  Rejected reports don't count. The IP itself is never
  stored with a report. Deleted after the hour (`expires_at`, Firestore TTL, which
  removes expired documents within about a day).

Google Cloud keeps the function's request logs, with the sender's IP, for 30 days
unless they're excluded: step 8 of the deploy excludes them, so that no IP can be
matched to a report's `received_at`.

`firestore.rules` denies all client access: only the function and the
maintainer's tools, through the Admin SDK, read or write.

## Sending a report

`POST` the report as JSON. From a browser, send it as `Content-Type: text/plain`:
the request needs no CORS preflight, and malformed JSON gets this function's
`400 bad_json` with CORS headers, where with `application/json` the hosting
framework rejects it first with a bare HTML page. Other clients can use
`application/json`. The answer is
`201 {"ok": true, "id": "<report id>"}`, or an error with `error` and `message`, for example `400
invalid_report`, `400 unknown_procedure`, `413` (over 10 KB) or `429` (rate limit).

A form that works without JavaScript posts `application/x-www-form-urlencoded`
and gets a `303` to `<SITE_URL>/grazie/#<report id>`, or a short error page. The
id is the person's receipt, for asking to see or delete their report; in the
fragment, it never reaches a server. Form fields:

- the report's fields by name; empty fields are left out, `12,50` is read as 12.5,
  and `consent_contact` is true for `on`, `true`, `1`, `si`;
- `documents[0][name]` and `documents[0][asked]` (or `documents.0.name`), `asked`
  being `si`/`on`/`true` or `no`/`false`; a document without `asked` is dropped;
- `claim_feedback[0][section]`, `[verdict]` and `[text]`; one without a verdict is dropped;
- `website`: the honeypot. Hide it from people; a post that fills it is answered
  as if it worked and thrown away.

The `procedure` must be listed in `<SITE_URL>/procedures.json`, which the
function fetches on the first report and keeps for an hour.

## Reviewing reports

From the repo root, `npm run reports -- list | show | find | accept | reject | delete | export`
(see the main README). Each command first says which database it is using. The export,
`reports-cache.json` at the repo root, keeps only what the published figures need: no
note, no correction text, no office, no contact.

For a request to see or delete someone's data, find the report by the code they got
when they sent it (`show <id>`) or by the email they left (`find <email>`), then
`delete <id>` (it also works once the report has expired and only the contact is left).
The published figures don't change at once: they are anonymous, and a block only changes
when at least 3 reports came in or dropped out against every earlier version (see
`tools/lib/reported.ts`). The report leaves them at the next change, or within 90 days,
when a block that can't change is removed.

Accepting is where one person sending three reports to reach the threshold of 3 is
caught: reports with the same procedure, month and answers that arrived close
together are one person's until shown otherwise.

## Running the tests

You need Node 22, Java 21 or later and the Firebase CLI (v15). The tests use the
`demo-pratiche-napoli` project, which only exists in the emulator, so no login
is needed and nothing reaches a real project.

```bash
cd reports/functions && npm ci && npm run test:emulator
```

To try the function by hand, put `RATE_LIMIT_SALT=anything` in
`functions/.secret.local` and, to use a locally served site, `SITE_URL=http://127.0.0.1:8000`
in `functions/.env.local` (both are ignored by git). Then:

```bash
cd reports && firebase emulators:start --only functions,firestore
```

The function is at `http://127.0.0.1:5001/demo-pratiche-napoli/europe-west8/submitReport`
and the stored documents are in the emulator UI at http://127.0.0.1:4000/firestore.

`lib/` is built on your machine before a deploy (the `predeploy` hook); the empty
`gcp-build` script stops Google's build from running `npm run build` again on
the uploaded files, which leave out `src/` and `scripts/`.

## Deploying (for the maintainer)

These steps need your personal Google account and a billing account, so only
you can do them. Don't use another account that the CLI is logged into.

1. Add your account to the CLI: `firebase login:add liampmaher1996@gmail.com`.
2. In the [Firebase console](https://console.firebase.google.com/), signed in as
   that account, create a new project (for example `pratiche-napoli`) and move it
   to the Blaze plan (functions need it; this traffic fits in the free tier).
3. Create the Firestore database in native mode in `europe-west8` (Milan): the
   privacy page says the data is in Milan.
4. From `reports/`, point the CLI at the project and account:
   ```bash
   firebase login:use liampmaher1996@gmail.com
   firebase use --add
   ```
   `use --add` asks for the project and an alias; call it `prod` and run
   `firebase use prod`. The default project stays `demo-pratiche-napoli`, so a
   deploy without it fails rather than reaching the wrong project.
5. Set the salt for the IP hash, a long random string you don't need to keep:
   ```bash
   openssl rand -hex 32 | firebase functions:secrets:set RATE_LIMIT_SALT --data-file -
   ```
6. If the site isn't at `https://liammaher.github.io/pratiche-napoli`, set
   `SITE_URL` in `functions/.env.prod` (no trailing slash).
7. Deploy: `firebase deploy --only functions,firestore`. This deploys the rules,
   the index and the TTL policies on `expires_at` for `reports`, `ratelimits` and
   `contacts`. In the console, under Firestore → Time-to-live, check that all three
   are listed and active; if not, add them for the `expires_at` field.
8. Stop Cloud Logging keeping the function's request logs, which hold the sender's
   IP (the privacy page says it isn't kept). The function runs as the Cloud Run
   service `submitreport` (check the name under Cloud Run):
   ```bash
   gcloud logging sinks update _Default --project <project id> \
     --add-exclusion='name=submit-report-requests,filter=resource.type="cloud_run_revision" AND resource.labels.service_name="submitreport" AND log_id("run.googleapis.com/requests")'
   ```
   Send a test report, then check under Logging that no request entry with its IP
   appears. The function's own error messages don't contain the IP.

The function's URL is printed at the end of the deploy; the site's form posts to it.
Build the site with it and the address for data requests:

```bash
REPORTS_URL=<function URL> CONTACT_EMAIL=<address> npm run build
```
