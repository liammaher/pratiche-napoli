// Builds the static site (see lib/site.ts) into site/, or the directory given.
// Refuses to build from a library that doesn't validate, and to overwrite a
// directory that isn't empty and isn't an earlier build.
// Usage: npm run build [-- <out dir>]
// SITE_URL sets the public base URL used in canonical links, the sitemap and
// the JSON index (default: the GitHub Pages address).

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSite, type Procedure } from "./lib/site.ts";
import { ROOT, loadRegistry, todayInRome, validateDir } from "./lib/validate.ts";

const library = path.join(ROOT, "procedures");
const out = path.resolve(process.argv[2] ?? path.join(ROOT, "site"));
const baseUrl = (process.env.SITE_URL ?? "https://liammaher.github.io/pratiche-napoli").replace(/\/+$/, "");
const repoUrl = "https://github.com/liammaher/pratiche-napoli";

const results = validateDir(library, loadRegistry(), todayInRome());
const invalid = results.filter((r) => r.errors.length);
if (invalid.length) {
  console.error(`not building: ${invalid.length} procedures don't validate (run npm run validate)`);
  for (const r of invalid) console.error(`✗ ${r.rel}`);
  process.exit(1);
}

const procedures = results.map((r) => r.doc as Procedure);
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8");
const files = buildSite(procedures, {
  baseUrl,
  repoUrl,
  built: new Date(),
  css: read("tools", "site", "style.css"),
  schema: read("contract", "procedure.schema.json"),
  fields: read("contract", "fields.json"),
});

if (existsSync(out) && readdirSync(out).length && !existsSync(path.join(out, "procedures.json"))) {
  console.error(`refusing to overwrite ${out}: it isn't empty and isn't an earlier build`);
  process.exit(2);
}
rmSync(out, { recursive: true, force: true });
for (const [rel, content] of files) {
  const file = path.join(out, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}
console.log(`built ${procedures.length} procedures, ${files.size} files, into ${path.relative(process.cwd(), out) || "."} (${baseUrl})`);
