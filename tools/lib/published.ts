// Fetches every version of the library that was published, so the reports
// aggregation can read them all (tools/aggregate-reports.ts).

import { spawnSync } from "node:child_process";

// What others pushed to origin from their clones is public: without it a
// version would be missed, and comparing it with the next one could single a
// report out. Only origin's own branches, which only its maintainers can
// push: not pull requests (refs/pull/*), which anyone can open on a public
// repository with a made-up `reported` block that would stop the run or
// shape what it publishes. Returns why it failed, or null.
export function fetchPublished(root: string): string | null {
  const run = spawnSync("git", ["-C", root, "fetch", "--quiet", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*"], {
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, // fail, never wait for a password
  });
  if (run.error) return run.error.message;
  if (run.status !== 0) return (run.stderr.trim() || `git fetch exited ${run.status}`).split("\n")[0];
  return null;
}
