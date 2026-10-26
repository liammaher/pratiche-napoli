import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { checkUpdated, contentChanged } from "./updated.ts";
import { ROOT } from "./validate.ts";

const doc = (updated: string, summary = "Prima versione.") => ({ id: "napoli/comune/test", updated, summary, ente: { name: "Comune" } });

test("only content counts as a change: not updated itself, nor key order", () => {
  assert.equal(contentChanged(doc("2026-10-20"), doc("2026-10-25")), false);
  const reordered = { ente: { name: "Comune" }, summary: "Prima versione.", id: "napoli/comune/test", updated: "2026-10-20" };
  assert.equal(contentChanged(doc("2026-10-20"), reordered), false);
  assert.equal(contentChanged(doc("2026-10-20"), doc("2026-10-20", "Seconda.")), true);
});

test("a changed procedure needs updated on or after the day of the change", () => {
  assert.equal(checkUpdated(doc("2026-10-20"), doc("2026-10-20"), "2026-10-25"), null);
  assert.match(checkUpdated(doc("2026-10-20"), doc("2026-10-20", "Seconda."), "2026-10-25")!, /changed on 2026-10-25 but updated is still 2026-10-20/);
  assert.equal(checkUpdated(doc("2026-10-20"), doc("2026-10-25", "Seconda."), "2026-10-25"), null);
  // Two changes on the same day keep the same date.
  assert.equal(checkUpdated(doc("2026-10-25"), doc("2026-10-25", "Terza."), "2026-10-25"), null);
  assert.match(checkUpdated(doc("2026-10-25"), doc("2026-10-24", "Seconda."), "2026-10-24")!, /went backwards/);
});

test("a new procedure needs an updated date no older than when it was added", () => {
  assert.equal(checkUpdated(undefined, doc("2026-10-25"), "2026-10-25"), null);
  assert.match(checkUpdated(undefined, doc("2026-10-01"), "2026-10-25")!, /changed on 2026-10-25/);
  const { updated: _, ...none } = doc("x");
  assert.equal(checkUpdated(undefined, none, "2026-10-25"), "has no updated date");
});

// A throwaway repo with one procedure on main and a branch that edits it.
function repo(initial = "id: napoli/comune/test\nupdated: 2026-10-20\nsummary: Prima versione.\n") {
  const dir = mkdtempSync(path.join(tmpdir(), "updated-"));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
  const git = (args: string[], date = "2026-10-20T12:00:00+02:00") => {
    const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", env: { ...env, GIT_AUTHOR_DATE: date } });
    assert.equal(r.status, 0, r.stderr);
  };
  const write = (text: string, name = "test.yaml") => {
    mkdirSync(path.join(dir, "procedures", "napoli", "comune"), { recursive: true });
    writeFileSync(path.join(dir, "procedures", "napoli", "comune", name), text);
  };
  git(["init", "-q", "-b", "main"]);
  write(initial);
  git(["add", "."]);
  git(["commit", "-qm", "first"]);
  git(["checkout", "-qb", "edit"]);
  const run = (base = "main") =>
    spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), path.join(ROOT, "tools", "check-updated.ts"), base], {
      cwd: dir,
      encoding: "utf8",
    });
  return { git, write, run };
}

test("CLI: a committed edit is dated by its author date, in Rome", () => {
  const r = repo();
  r.write("id: napoli/comune/test\nupdated: 2026-10-20\nsummary: Seconda versione.\n");
  // Just after midnight in Rome, still the 23rd in UTC.
  r.git(["commit", "-qam", "edit"], "2026-10-24T00:30:00+02:00");
  const bad = r.run();
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /test\.yaml: changed on 2026-10-24 but updated is still 2026-10-20/);

  r.write("id: napoli/comune/test\nupdated: 2026-10-24\nsummary: Seconda versione.\n");
  r.git(["commit", "-qam", "bump"], "2026-10-24T00:40:00+02:00");
  const good = r.run();
  assert.equal(good.status, 0, good.stderr);
  assert.match(good.stdout, /1\/1 changed procedures/);
});

test("CLI: comment-only commits and merges don't move the date of a change", () => {
  const file = (ente: string, updated: string, summary: string, tail = "") =>
    `id: napoli/comune/test\nente: ${ente}\nnote: a\nupdated: ${updated}\nsummary: ${summary}\n${tail}`;
  const r = repo(file("Comune", "2026-10-20", "Prima versione."));
  r.write(file("Comune", "2026-10-21", "Seconda versione."));
  r.git(["commit", "-qam", "edit"], "2026-10-21T12:00:00+02:00");
  r.write(file("Comune", "2026-10-21", "Seconda versione.", "# a comment\n"));
  r.git(["commit", "-qam", "comment"], "2026-10-23T12:00:00+02:00");
  // Like CI: HEAD is a later merge of the branch into a main that changed the same file.
  r.git(["checkout", "-q", "main"]);
  r.write(file("Comune di Napoli", "2026-10-20", "Prima versione."));
  r.git(["commit", "-qam", "main moves"], "2026-10-22T12:00:00+02:00");
  r.git(["checkout", "-q", "--detach", "main"]);
  r.git(["merge", "-q", "--no-ff", "-m", "merge", "edit"], "2026-10-30T12:00:00+01:00");
  const run = r.run();
  assert.equal(run.status, 0, run.stderr + run.stdout);

  // An uncommitted comment doesn't count as a change today either.
  r.write(file("Comune di Napoli", "2026-10-21", "Seconda versione.", "# another comment\n"));
  assert.equal(r.run().status, 0);
});

test("CLI: comment-only edits and new untracked files are handled", () => {
  const r = repo();
  r.write("# just a comment\nid: napoli/comune/test\nupdated: 2026-10-20\nsummary: Prima versione.\n");
  assert.equal(r.run().status, 0);

  // Uncommitted, so the change is today's.
  r.write("id: napoli/comune/test\nupdated: 2026-10-20\nsummary: Modificata.\n");
  assert.match(r.run().stderr, /changed on \d{4}-\d{2}-\d{2} but updated is still 2026-10-20/);

  r.write("id: napoli/comune/test\nupdated: 2026-10-20\nsummary: Prima versione.\n");
  r.write("id: napoli/comune/new\nupdated: 2026-01-01\nsummary: Nuova.\n", "new.yaml");
  assert.match(r.run().stderr, /new\.yaml: changed on \d{4}-\d{2}-\d{2} but updated is still 2026-01-01/);
});

test("CLI: an unknown base is an error, not a pass", () => {
  const run = repo().run("nope");
  assert.equal(run.status, 2);
  assert.match(run.stderr, /can't compare with nope/);
});
