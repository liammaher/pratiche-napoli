// Checks that every procedure or situation changed since a base commit has its
// `updated` date bumped (the rule is in lib/updated.ts). The working tree is compared,
// so an uncommitted change counts as made today; a committed one is dated by
// the author date of the newest commit that changed the content, which
// survives a rebase.
// Usage: npm run check:updated [-- <base>]   (default origin/main)

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkUpdated, contentChanged } from "./lib/updated.ts";
import { parseProcedure, todayInRome } from "./lib/validate.ts";

const base = process.argv[2] ?? "origin/main";
const env = { ...process.env, TZ: "Europe/Rome" }; // for git's format-local dates

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}

let top: string;
let mergeBase: string;
try {
  top = git("rev-parse", "--show-toplevel");
  mergeBase = git("-C", top, "merge-base", base, "HEAD");
} catch (e) {
  console.error(`can't compare with ${base}: ${(e as Error).message.split("\n")[0]}`);
  console.error("(in CI, check out with fetch-depth: 0 so the base branch is there)");
  process.exit(2);
}

interface Change {
  path: string;
  oldPath?: string; // absent for a new file
}

const isYaml = (p: string) => /\.ya?ml$/i.test(p);
const changes: Change[] = [];
for (const line of git("-C", top, "diff", "--name-status", "-M", mergeBase, "--", "procedures", "situations").split("\n")) {
  if (!line) continue;
  const [status, a, b] = line.split("\t");
  if (status === "D") continue;
  const p = b ?? a;
  if (!isYaml(p)) continue;
  changes.push({ path: p, oldPath: status === "A" ? undefined : a });
}
for (const p of git("-C", top, "ls-files", "--others", "--exclude-standard", "--", "procedures", "situations").split("\n")) {
  if (p && isYaml(p)) changes.push({ path: p });
}

const today = todayInRome();
let failed = 0;
for (const c of changes) {
  // Files that don't parse are the validator's to report.
  const after = load(() => readFileSync(path.join(top, c.path), "utf8"));
  if (!after) continue;
  const before = c.oldPath ? load(() => git("-C", top, "show", `${mergeBase}:${c.oldPath}`)) : undefined;
  const problem = checkUpdated(before, after, changedOn(c.path, after));
  if (problem) {
    failed++;
    console.error(`✗ ${c.path}: ${problem}`);
  } else {
    console.log(`✓ ${c.path}`);
  }
}
console.log(`\n${changes.length - failed}/${changes.length} changed procedures have their updated date`);
process.exit(failed ? 1 : 0);

// The day of the newest change to the content of p (whose working-tree
// version is `now`): today if it differs from HEAD's, otherwise the newest
// commit on the branch that changed it. Comment- or layout-only commits and
// merges (in CI, HEAD is GitHub's merge commit, dated when CI runs) don't count.
function changedOn(p: string, now: Record<string, unknown>): string {
  const head = load(() => git("-C", top, "show", `HEAD:${p}`));
  if (!head || contentChanged(head, now)) return today;
  const log = git("-C", top, "log", "--no-merges", "--full-history", "--format=%H %ad", "--date=format-local:%Y-%m-%d", `${mergeBase}..HEAD`, "--", p);
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha, date] = line.split(" ");
    const at = load(() => git("-C", top, "show", `${sha}:${p}`));
    const parent = load(() => git("-C", top, "show", `${sha}^:${p}`)); // absent when added or renamed there
    if (!at || !parent || contentChanged(parent, at)) return date;
  }
  return today;
}

function load(read: () => string): Record<string, unknown> | undefined {
  try {
    const doc = parseProcedure(read());
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
