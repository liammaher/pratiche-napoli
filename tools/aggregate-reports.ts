// Updates every procedure's `reported` block from the accepted reports that
// `npm run reports -- export` saved (see lib/reported.ts). A procedure whose
// figures changed gets today's `updated`; one whose reports aged out of the
// window loses its block. A block stays as it is while, across every version
// ever published, some reports would stand apart in a group of fewer than 3
// (see nextReported). Nothing else in the files changes.
// Usage: npm run reports:aggregate [-- <reports-cache.json>]

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { markProblem, nextReported, sameReported, withReported, type Reported, type ReviewedReport } from "./lib/reported.ts";
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
const badMarks = markProblem(reports);
if (badMarks) {
  console.error(`not aggregating: ${badMarks}`);
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

const everPublished = publishedBlocks();
let changed = 0;
for (const { rel, doc } of results) {
  const p = doc as { id: string; documents?: { name: string }[]; reported?: Reported };
  const mine = reports.filter((r) => r.procedure === p.id);
  const { block, held } = nextReported(
    lineage(p.id, everPublished, [...mine.map((r) => r.mark), ...(p.reported?.basis ?? [])]),
    p.reported,
    mine,
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

// Every block any procedure file had in the repository's history, on every
// branch (each was public), with the id of the procedure it was in.
function publishedBlocks(): { id: string; block: Reported }[] {
  const git = (...args: string[]) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let commits: string[] = [];
  try {
    commits = git("rev-list", "--all", "--", "procedures").split("\n").filter(Boolean);
  } catch {
    return []; // not a git checkout: only the working tree
  }
  const out = new Map<string, { id: string; block: Reported }>();
  for (const sha of commits) {
    let files: string[] = [];
    try {
      // "<sha>:<path>" for each file with a block; git grep exits 1 when none has.
      files = git("grep", "-l", "^reported:", sha, "--", "procedures").split("\n").filter(Boolean);
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const doc = parseProcedure(git("show", file)) as { id?: string; reported?: Reported } | undefined;
        if (doc?.id && doc.reported?.basis) out.set(`${doc.id} ${JSON.stringify(doc.reported)}`, { id: doc.id, block: doc.reported });
      } catch {
        // didn't parse there
      }
    }
  }
  return [...out.values()];
}

// The versions that were this procedure's: those under its id and, through a
// move or a renamed id, any that shares a report with them (a mark is one
// report's, whatever file it was in). `marks` are its reports' now.
function lineage(id: string, all: { id: string; block: Reported }[], marks: string[]): Reported[] {
  const known = new Set(marks);
  const mine = new Set(all.filter((v) => v.id === id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const v of mine) for (const m of v.block.basis) known.add(m);
    for (const v of all) {
      if (!mine.has(v) && v.block.basis.some((m) => known.has(m))) {
        mine.add(v);
        grew = true;
      }
    }
  }
  return [...mine].map((v) => v.block);
}
