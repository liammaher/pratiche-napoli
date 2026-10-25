// Validates every procedure under procedures/. Exits non-zero on any error.
// Usage: npm run validate

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { ROOT, loadRegistry, validateProcedure } from "./lib/validate.ts";

function listYaml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listYaml(full));
    else if (/\.ya?ml$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = listYaml(path.join(ROOT, "procedures"));
const docs = files.map((file) => ({ rel: path.relative(ROOT, file), doc: parse(readFileSync(file, "utf8")) }));
const knownIds = new Set(docs.map(({ doc }) => doc?.id).filter((id): id is string => typeof id === "string"));
const ctx = { registry: loadRegistry(), knownIds, today: new Date().toISOString().slice(0, 10) };

let failed = 0;
for (const { rel, doc } of docs) {
  const errors = validateProcedure(doc, rel, ctx);
  if (errors.length) {
    failed++;
    console.error(`✗ ${rel}`);
    for (const e of errors) console.error(`  - ${e}`);
  } else {
    console.log(`✓ ${rel}`);
  }
}
console.log(`\n${docs.length - failed}/${docs.length} procedures valid`);
process.exit(failed ? 1 : 0);
