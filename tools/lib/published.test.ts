import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fetchPublished } from "./published.ts";

// Commits made here must not depend on the user's git config (signing, hooks).
const env = {
  ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.org", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.org",
};
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();

function commit(repo: string, text: string): string {
  writeFileSync(path.join(repo, "f.txt"), text);
  git(repo, "add", "f.txt");
  git(repo, "commit", "-q", "-m", text);
  return git(repo, "rev-parse", "HEAD");
}

test("fetches what other clones pushed, never pull requests", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "published-"));
  try {
    const origin = path.join(dir, "origin.git");
    git(dir, "init", "-q", "--bare", "-b", "main", origin);
    const a = path.join(dir, "a");
    git(dir, "clone", "-q", origin, a);
    commit(a, "first");
    git(a, "push", "-q", "origin", "HEAD:main");
    const b = path.join(dir, "b");
    git(dir, "clone", "-q", origin, b); // cloned before what follows

    const pushed = commit(a, "published from a");
    git(a, "push", "-q", "origin", "HEAD:main");
    // Anyone can open a pull request on a public repository: GitHub keeps
    // its head as refs/pull/<n>/head, with whatever `reported` block it made up.
    git(a, "checkout", "-q", "-b", "stranger");
    const stranger = commit(a, "a stranger's pull request");
    git(a, "push", "-q", "origin", "stranger");
    git(origin, "update-ref", "refs/pull/1/head", stranger);
    git(a, "push", "-q", "origin", "--delete", "stranger");

    const all = () => git(b, "rev-list", "--all").split("\n");
    assert.ok(!all().includes(pushed));
    assert.equal(fetchPublished(b), null);
    assert.ok(all().includes(pushed), "a version pushed from another clone");
    assert.ok(!all().includes(stranger), "a pull request's head must not be read as published");

    // No origin to fetch from: the history may be incomplete, so it fails.
    git(b, "remote", "remove", "origin");
    assert.match(fetchPublished(b) ?? "", /origin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
