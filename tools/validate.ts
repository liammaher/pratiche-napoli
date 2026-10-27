// Validates every procedure under procedures/ (or the directory given), and,
// for the whole library, the situations under situations/ and the form
// layouts under layouts/.
// Exits non-zero on any error, or when there is nothing to validate.
// Usage: npm run validate [-- <dir>]

import path from "node:path";
import { ROOT, loadRegistry, procedureIdFromPath, todayInRome, validateDir, validateLayouts, validateOffices, validateSituations } from "./lib/validate.ts";

const library = path.join(ROOT, "procedures");
const target = path.resolve(process.argv[2] ?? library);
// A path inside the library is validated in context (ids, related links);
// any other directory is treated as a library of its own.
const inLibrary = target === library || target.startsWith(library + path.sep);
const dir = inLibrary ? library : target;

let results;
try {
  results = validateDir(dir, loadRegistry(), todayInRome(), inLibrary ? target : undefined);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

if (results.length === 0) {
  console.error(`no procedures found in ${target}`);
  process.exit(1);
}

// Situations point at procedures, so they're checked with the real library.
const situations =
  inLibrary && target === library
    ? validateSituations(
        path.join(ROOT, "situations"),
        new Set(results.map((r) => procedureIdFromPath(r.rel))),
        todayInRome(),
      ).map((r) => ({ ...r, rel: path.join("situations", r.rel) }))
    : [];

// Layouts place procedures' forms, so they too need the whole library.
const layouts =
  inLibrary && target === library
    ? validateLayouts(path.join(ROOT, "layouts"), results).map((r) => ({ ...r, rel: path.join("layouts", r.rel) }))
    : [];

// Offices are picked by the vault fields desk channels name.
const offices =
  inLibrary && target === library
    ? validateOffices(path.join(ROOT, "offices")).map((r) => ({ ...r, rel: path.join("offices", r.rel) }))
    : [];

let failed = 0;
for (const { rel, errors } of [...results, ...situations, ...layouts, ...offices]) {
  if (errors.length) {
    failed++;
    console.error(`✗ ${rel}`);
    for (const e of errors) console.error(`  - ${e}`);
  } else {
    console.log(`✓ ${rel}`);
  }
}
const total = results.length + situations.length + layouts.length + offices.length;
console.log(`\n${total - failed}/${total} procedures, situations, layouts and offices valid`);
process.exit(failed ? 1 : 0);
