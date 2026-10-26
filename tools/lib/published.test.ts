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

test("fetches what other clones pushed and pull requests' branches deleted since", () => {
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
    git(a, "checkout", "-q", "-b", "pr");
    const prOnly = commit(a, "only on a deleted PR branch");
    git(a, "push", "-q", "origin", "pr");
    git(origin, "update-ref", "refs/pull/1/head", prOnly); // as GitHub keeps it
    git(a, "push", "-q", "origin", "--delete", "pr");

    const all = () => git(b, "rev-list", "--all").split("\n");
    assert.ok(!all().includes(pushed));
    assert.equal(fetchPublished(b), null);
    assert.ok(all().includes(pushed), "a version pushed from another clone");
    assert.ok(all().includes(prOnly), "a pull request's branch deleted since");

    // No origin to fetch from: the history may be incomplete, so it fails.
    git(b, "remote", "remove", "origin");
    assert.match(fetchPublished(b) ?? "", /origin/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
