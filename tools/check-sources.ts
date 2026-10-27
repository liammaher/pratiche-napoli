// Checks the official pages and forms the procedures cite, and the pages the
// office lists (offices/*.json) were read from (see lib/sources.ts),
// and prints what to re-verify: every document with a sha256, and tonight's
// seventh of the other pages (all of them with --all), but only one address
// of a site that refuses the checker (a 403, a 429, a 404 with its home's).
// The latest result for each address, with its ETag and Last-Modified, is
// kept in --state between runs, so the report covers the whole week. With
// --out, also writes the report there, an empty file when everything answers
// as recorded: the nightly workflow turns it into a GitHub issue. Exits 0 when the check ran,
// problems or not, and 1 when it says nothing (most sites gave no answer),
// writing no report and keeping the state as it was.
// Usage: npm run check:sources [-- --all] [--state file] [--out report.md]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  checkTargets,
  collectTargets,
  dayNumber,
  heldBack,
  inconclusive,
  known,
  merge,
  report,
  secondOpinion,
  targetKey,
  tonight,
  validatorsTonight,
  type State,
} from "./lib/sources.ts";
import { ROOT, loadRegistry, todayInRome, validateDir, validateOffices } from "./lib/validate.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    all: { type: "boolean" },
    state: { type: "string", default: path.join(ROOT, ".cache", "sources-state.json") },
  },
});
const stateFile = path.resolve(values.state!);
let state: State = {};
try {
  const saved = JSON.parse(readFileSync(stateFile, "utf8"));
  // Entries without a status and a date would fall out of every night's
  // share and still count as missing: they are dropped.
  if (saved && typeof saved === "object" && !Array.isArray(saved)) {
    state = Object.fromEntries(
      Object.entries(saved as State).filter(([, seen]) => typeof seen?.status === "string" && /^\d{4}-\d{2}-\d{2}$/.test(String(seen.checkedOn))),
    );
  }
} catch {
  // first run, or no saved state: everything is new
}

const today = todayInRome();
const results = validateDir(path.join(ROOT, "procedures"), loadRegistry(), today);
// An office's address is a source like a procedure's: a moved desk shows as a changed page.
const offices = validateOffices(path.join(ROOT, "offices"));
// A file that doesn't parse would silently drop its addresses, and could close the issue.
const unread = [...results, ...offices].filter((r) => !r.doc);
if (unread.length) {
  console.error(`can't read ${unread.map((r) => r.rel).join(", ")} (run npm run validate); not checking`);
  process.exit(2);
}
type Cited = Parameters<typeof collectTargets>[0][number];
const targets = collectTargets([
  ...results.map((r) => r.doc as Cited),
  ...offices.map((r) => ({ id: `offices/${path.basename(r.rel, ".json")}`, sources: (r.doc as Cited).sources })),
]);
const share = values.all ? targets : tonight(targets, dayNumber(today), state);
console.log(`checking ${share.length} of ${targets.length} addresses…`);

const checked = await checkTargets(share, fetch, {
  userAgent: "pratiche-napoli-source-monitor/1.0 (+https://github.com/liammaher/pratiche-napoli)",
  validators: validatorsTonight(state, share, dayNumber(today)),
});
const why = inconclusive(checked);
if (why) {
  console.error(`check inconclusive (${why}): probably the checker's network or certificates, not the sources; no report written`);
  process.exit(1);
}
// A 304 hands back the validators it was sent, the very same object.
const notModified = checked.filter((r) => r.status === "ok" && r.validators && r.validators === state[targetKey(r.target)]?.validators).length;
// The archive's answer from the last week is reused, not asked again; an
// older one stands when it can't be renewed.
const annotated = await secondOpinion(checked, fetch, {
  saved: new Map(
    Object.entries(state).flatMap(([key, seen]) =>
      seen.wayback ? [[key, { wayback: seen.wayback, status: seen.waybackStatus, on: seen.waybackOn ?? seen.checkedOn }]] : [],
    ),
  ),
  today,
});

// A site that refused its probe again: the addresses it wasn't asked are refused with it.
const next = merge(state, [...annotated, ...heldBack(targets, annotated, state)], today, targets);
mkdirSync(path.dirname(stateFile), { recursive: true });
writeFileSync(stateFile, JSON.stringify(next, null, 2) + "\n");

const latest = known(next, targets, today);
// tonight() leaves no address without a recent result; if one is missing,
// the report would speak for pages nobody checked, so it isn't written.
if (latest.length < targets.length) {
  console.error(`only ${latest.length} of ${targets.length} addresses have a recent result; no report written`);
  process.exit(1);
}
const text = report(latest, today);
if (values.out) writeFileSync(path.resolve(values.out), text);
const unchecked = latest.filter((r) => r.status === "uncheckable" || r.status === "blocked");
console.log(`${checked.length} checked tonight, ${notModified} unchanged since last time (304).`);
console.log(
  text ||
    `All ${latest.length - unchecked.length} addresses that could be checked this week answer, and every recorded sha256 still matches.` +
      (unchecked.length ? `\n${unchecked.length} couldn't be checked (certificate, or blocked by the site): ${unchecked.map((r) => r.target.url).join(", ")}` : ""),
);
