// Updates every procedure's `reported` block from the accepted reports that
// `npm run reports -- export` saved (see lib/reported.ts). A procedure whose
// figures changed gets today's `updated`; one whose reports aged out of the
// window loses its block. A block stays as it is while fewer than 3 reports
// came in or dropped out since it (see nextReported). Nothing else in the
// files changes.
// Usage: npm run reports:aggregate [-- <reports-cache.json>]

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nextReported, sameReported, withReported, type Reported, type ReviewedReport } from "./lib/reported.ts";
import { ROOT, loadRegistry, todayInRome, validateDir } from "./lib/validate.ts";

const cache = path.resolve(process.argv[2] ?? path.join(ROOT, "reports-cache.json"));
let reports: ReviewedReport[];
try {
  reports = JSON.parse(readFileSync(cache, "utf8"));
} catch (e) {
  console.error(`can't read ${cache}: ${(e as Error).message.split("\n")[0]}`);
  console.error("(export the accepted reports first: npm run reports -- export)");
  process.exit(2);
}

const library = path.join(ROOT, "procedures");
const results = validateDir(library, loadRegistry(), todayInRome());
const invalid = results.filter((r) => r.errors.length);
if (invalid.length) {
  console.error(`not aggregating: ${invalid.length} procedures don't validate (run npm run validate)`);
  process.exit(1);
}

const today = todayInRome();
const known = new Set(results.map((r) => (r.doc as { id: string }).id));
const unknown = new Set(reports.map((r) => r.procedure).filter((id) => !known.has(id)));
for (const id of unknown) console.warn(`! reports for ${id}, which is no longer in the library`);

let changed = 0;
for (const { rel, doc } of results) {
  const p = doc as { id: string; documents?: { name: string }[]; reported?: Reported };
  const { block, held } = nextReported(
    p.reported,
    reports.filter((r) => r.procedure === p.id),
    (p.documents ?? []).map((d) => d.name),
    today,
  );
  if (held) console.log(`= ${rel}: kept as it is (${held})`);
  if (sameReported(p.reported, block)) continue;
  const file = path.join(library, rel);
  writeFileSync(file, withReported(readFileSync(file, "utf8"), block, today));
  changed++;
  console.log(`${block ? "✓" : "–"} ${rel}: ${block ? `${block.count} reports` : "too few recent reports, block removed"}`);
}
console.log(`\n${changed} procedures updated from ${reports.length} accepted reports`);
