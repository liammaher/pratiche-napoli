// Builds the static site (see lib/site.ts) into site/, or the directory given.
// Refuses to build from a library that doesn't validate, and to overwrite a
// directory that isn't empty and isn't an earlier build.
// Usage: npm run build [-- <out dir>]
// SITE_URL sets the public base URL used in canonical links, the sitemap and
// the JSON index (default: the GitHub Pages address). REPORTS_URL (the
// submitReport function) and CONTACT_EMAIL (named on the privacy page) together
// turn on the report form; with only one of them the build stops.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSite, type Offices, type Procedure, type Situation } from "./lib/site.ts";
import { ROOT, SIGNING, loadRegistry, procedureIdFromPath, todayInRome, validateDir, validateLayouts, validateOffices, validateSituations } from "./lib/validate.ts";

const library = path.join(ROOT, "procedures");
const out = path.resolve(process.argv[2] ?? path.join(ROOT, "site"));
const baseUrl = (process.env.SITE_URL ?? "https://liammaher.github.io/pratiche-napoli").replace(/\/+$/, "");
const repoUrl = "https://github.com/liammaher/pratiche-napoli";

const results = validateDir(library, loadRegistry(), todayInRome());
const situationResults = validateSituations(
  path.join(ROOT, "situations"),
  new Set(results.map((r) => procedureIdFromPath(r.rel))),
  todayInRome(),
);
const layoutResults = validateLayouts(path.join(ROOT, "layouts"), results);
const officeResults = validateOffices(path.join(ROOT, "offices"));
const invalid = [...results, ...situationResults, ...layoutResults, ...officeResults].filter((r) => r.errors.length);
if (invalid.length) {
  console.error(`not building: ${invalid.length} procedures, situations, layouts or offices don't validate (run npm run validate)`);
  for (const r of invalid) console.error(`✗ ${r.rel}`);
  process.exit(1);
}

const procedures = results.map((r) => r.doc as Procedure);
const read = (...p: string[]) => readFileSync(path.join(ROOT, ...p), "utf8");
const { REPORTS_URL, CONTACT_EMAIL } = process.env;
if (!REPORTS_URL !== !CONTACT_EMAIL) {
  console.error("set both REPORTS_URL and CONTACT_EMAIL for the report form, or neither");
  process.exit(1);
}
const files = buildSite(procedures, {
  baseUrl,
  repoUrl,
  built: new Date(),
  css: read("tools", "site", "style.css"),
  schema: read("contract", "procedure.schema.json"),
  fields: read("contract", "fields.json"),
  signing: SIGNING,
  offices: Object.fromEntries(officeResults.map((r) => [path.basename(r.rel, ".json"), r.doc as Offices])),
  reports: REPORTS_URL && CONTACT_EMAIL ? { url: REPORTS_URL, contact: CONTACT_EMAIL, script: read("tools", "site", "report.js") } : undefined,
}, situationResults.map((r) => r.doc as Situation));

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
