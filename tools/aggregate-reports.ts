// Updates every procedure's `reported` block from the accepted reports that
// `npm run reports -- export` saved (see lib/reported.ts). A procedure whose
// figures changed gets today's `updated`; one whose reports aged out of the
// window loses its block. A block stays as it is while fewer than 3 reports
// came in or dropped out since it (see nextReported). Nothing else in the
// files changes.
// Usage: npm run reports:aggregate [-- <reports-cache.json>]

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { nextReported, sameReported, withReported, type Reported, type ReviewedReport } from "./lib/reported.ts";
import { ROOT, loadRegistry, parseProcedure, todayInRome, validateDir } from "./lib/validate.ts";

// A path given is read from where the command was run (npm keeps it in INIT_CWD).
const cache = process.argv[2] ? path.resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2]) : path.join(ROOT, "reports-cache.json");
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
    published(path.join("procedures", rel), p.reported),
    reports.filter((r) => r.procedure === p.id),
    (p.documents ?? []).map((d) => d.name),
    today,
  );
  if (held) console.log(`= ${rel}: ${held}`);
  if (sameReported(p.reported, block)) continue;
  const file = path.join(library, rel);
  writeFileSync(file, withReported(readFileSync(file, "utf8"), block, today));
  changed++;
  console.log(`${block ? "✓" : "–"} ${rel}: ${block ? `${block.count} reports` : "too few recent reports, block removed"}`);
}
console.log(`\n${changed} procedures updated from ${reports.length} accepted reports`);

// Every version of a procedure's block in the repository's history, oldest
// first, then the one in the working tree: each was (or will be) public.
function published(file: string, current: Reported | undefined): Reported[] {
  const git = (...args: string[]) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const versions: Reported[] = [];
  let commits: string[] = [];
  try {
    commits = git("log", "--format=%H", "--reverse", "--all", "--", file).split("\n").filter(Boolean);
  } catch {
    // not a git checkout: only the working tree
  }
  for (const sha of commits) {
    try {
      const doc = parseProcedure(git("show", `${sha}:${file}`)) as { reported?: Reported } | undefined;
      if (doc?.reported?.basis) versions.push(doc.reported);
    } catch {
      // the file didn't exist there, or didn't parse
    }
  }
  if (current?.basis) versions.push(current);
  return versions;
}
