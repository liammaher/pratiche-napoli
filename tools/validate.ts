// Validates every procedure under procedures/ (or the directory given).
// Exits non-zero on any error, or when there is nothing to validate.
// Usage: npm run validate [-- <dir>]

import path from "node:path";
import { ROOT, loadRegistry, todayInRome, validateDir } from "./lib/validate.ts";

const dir = path.resolve(process.argv[2] ?? path.join(ROOT, "procedures"));

let results;
try {
  results = validateDir(dir, loadRegistry(), todayInRome());
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

if (results.length === 0) {
  console.error(`no procedures found in ${dir}`);
  process.exit(1);
}

let failed = 0;
for (const { rel, errors } of results) {
  if (errors.length) {
    failed++;
    console.error(`✗ ${rel}`);
    for (const e of errors) console.error(`  - ${e}`);
  } else {
    console.log(`✓ ${rel}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} procedures valid`);
process.exit(failed ? 1 : 0);
