// Checks every official page and form the procedures cite (see lib/sources.ts)
// and prints what to re-verify. With --out, also writes the report there, an
// empty file when everything answers as recorded: the nightly workflow turns
// it into a GitHub issue. Exits 0 whenever the check ran, problems or not.
// Usage: npm run check:sources [-- --out report.md]

import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkTargets, collectTargets, report } from "./lib/sources.ts";
import { ROOT, loadRegistry, todayInRome, validateDir } from "./lib/validate.ts";

const { values } = parseArgs({ options: { out: { type: "string" } } });

const results = validateDir(path.join(ROOT, "procedures"), loadRegistry(), todayInRome());
const targets = collectTargets(results.flatMap((r) => (r.doc ? [r.doc as Parameters<typeof collectTargets>[0][number]] : [])));
console.log(`checking ${targets.length} addresses…`);

const checked = await checkTargets(targets, fetch, {
  userAgent: "pratiche-napoli-source-monitor/1.0 (+https://github.com/liammaher/pratiche-napoli)",
});
const text = report(checked, todayInRome());
if (values.out) writeFileSync(path.resolve(values.out), text);
const uncheckable = checked.filter((r) => r.status === "uncheckable");
console.log(
  text ||
    `All ${targets.length - uncheckable.length} addresses that could be checked answer, and every recorded sha256 still matches.` +
      (uncheckable.length ? `\n${uncheckable.length} couldn't be checked (certificate): ${uncheckable.map((r) => r.target.url).join(", ")}` : ""),
);
