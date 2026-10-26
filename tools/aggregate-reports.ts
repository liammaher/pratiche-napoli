// Updates every procedure's `reported` block from the accepted reports that
// `npm run reports -- export` saved (see lib/reported.ts). A procedure whose
// figures changed gets today's `updated`; one whose reports aged out of the
// window loses its block. Reports published together leave together, new ones
// come in 3 at a time, and a figure is shown only if it holds in each such
// group, so that comparing versions gives no one away (see nextReported).
// Nothing else in the files changes. The export is used once, and only within
// an hour of being made: it is removed as soon as it is read, so an old one
// can't bring back a report deleted since. The history is read from git, and
// the run stops if it can't be read whole.
// Usage: npm run reports:aggregate [-- <reports-cache.json>]

import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cacheProblem, markProblem, nextReported, sameReported, withReported, type Reported, type ReportsCache, type ReviewedReport } from "./lib/reported.ts";
import { ROOT, loadRegistry, parseProcedure, todayInRome, validateDir } from "./lib/validate.ts";

// A path given is read from where the command was run (npm keeps it in INIT_CWD).
const cache = process.argv[2] ? path.resolve(process.env.INIT_CWD ?? process.cwd(), process.argv[2]) : path.join(ROOT, "reports-cache.json");
let read: unknown;
try {
  read = JSON.parse(readFileSync(cache, "utf8"));
} catch (e) {
  console.error(`can't read ${cache}: ${(e as Error).message.split("\n")[0]}`);
  console.error("(export the accepted reports first: npm run reports -- export)");
  process.exit(2);
}
const { export: isExport, problem } = cacheProblem(read, new Date());
if (isExport) {
  rmSync(cache);
  console.log(`(read and removed ${cache}: export again for the next run)`);
}
if (problem) {
  console.error(`not aggregating ${cache}: ${problem}`);
  process.exit(2);
}
const reports: ReviewedReport[] = (read as ReportsCache).reports;
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

// Every published version must be read, so anything short of the whole
// history stops the run: no git, not a checkout (a downloaded copy), or a
// shallow clone, which has only part of it.
const git = (...args: string[]) =>
  execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 30 });
try {
  if (git("rev-parse", "--is-shallow-repository").trim() === "true") {
    console.error("not aggregating: this clone is shallow, so earlier versions can't be read (git fetch --unshallow)");
    process.exit(2);
  }
} catch (e) {
  console.error(`not aggregating: can't read the history with git, so earlier versions would be missed (${gitError(e)})`);
  process.exit(2);
}
let history: ReturnType<typeof publishedBlocks>;
try {
  history = publishedBlocks();
} catch (e) {
  console.error(`not aggregating: can't read the history with git (${gitError(e)})`);
  process.exit(2);
}
const { blocks: everPublished, unread } = history;
// A version left out would merge groups of reports it tells apart.
if (unread.length) {
  console.error(`not aggregating: can't read the published block in ${unread.join(", ")}`);
  console.error("(a local branch never pushed can be deleted; a version that was pushed stays public, so what it showed must be checked by hand)");
  process.exit(2);
}
let changed = 0;
for (const { rel, doc } of results) {
  const p = doc as { id: string; documents?: { name: string }[]; reported?: Reported };
  const mine = reports.filter((r) => r.procedure === p.id);
  const { block, note } = nextReported(
    [...lineage(p.id, everPublished, [...mine.map((r) => r.mark), ...(p.reported?.basis ?? [])]), ...(p.reported ? [p.reported] : [])],
    mine,
    (p.documents ?? []).map((d) => d.name),
    today,
  );
  if (note) console.log(`= ${rel}: ${note}`);
  if (sameReported(p.reported, block)) continue;
  const file = path.join(library, rel);
  writeFileSync(file, withReported(readFileSync(file, "utf8"), block, today));
  changed++;
  console.log(`${block ? "✓" : "–"} ${rel}: ${block ? `${block.count} reports` : "too few recent reports, block removed"}`);
}
console.log(`\n${changed} procedures updated from ${reports.length} accepted reports`);

// Every block any procedure file had in the repository's history, on every
// branch (each was public), with the id of the procedure it was in; and the
// files with a block that can't be read (a merge conflict left in, a block
// without its basis), which must not be left out.
function publishedBlocks(): { blocks: { id: string; block: Reported }[]; unread: string[] } {
  // Every commit, not only those `-- procedures` keeps: history
  // simplification skips the side of a merge that ended up unchanged, a
  // published version reverted on a branch included.
  const commits = git("rev-list", "--all").split("\n").filter(Boolean);
  const out = new Map<string, { id: string; block: Reported }>();
  const unread: string[] = [];
  for (const sha of commits) {
    let files: string[] = [];
    try {
      // "<sha>:<path>" for each file with a block.
      files = git("grep", "-l", "^reported:", sha, "--", "procedures").split("\n").filter(Boolean);
    } catch (e) {
      // git grep exits 1 when no file has one; anything else is an error.
      if ((e as { status?: number }).status === 1 && !(e as { stderr?: string }).stderr) continue;
      throw e;
    }
    for (const file of files) {
      try {
        const doc = parseProcedure(git("show", file)) as { id?: string; reported?: Reported } | undefined;
        const basis = doc?.reported?.basis;
        if (!doc?.id || !Array.isArray(basis) || !basis.every((m) => typeof m === "string")) unread.push(file);
        else out.set(`${doc.id} ${JSON.stringify(doc.reported)}`, { id: doc.id, block: doc.reported! });
      } catch {
        unread.push(file);
      }
    }
  }
  return { blocks: [...out.values()], unread };
}

// What git said when it failed, in one line.
function gitError(e: unknown): string {
  const err = e as { stderr?: string; message?: string };
  return (err.stderr?.trim() || err.message || String(e)).split("\n")[0];
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
