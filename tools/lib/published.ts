// Fetches every version of the library that was published, so the reports
// aggregation can read them all (tools/aggregate-reports.ts).

import { spawnSync } from "node:child_process";

// What others pushed from their clones is public, and so is every pull
// request's branch, which GitHub keeps (refs/pull/<n>/head) after it is merged
// or deleted. Without them a version would be missed, and comparing it with
// the next one could single a report out. Returns why it failed, or null.
export function fetchPublished(root: string): string | null {
  const run = spawnSync(
    "git",
    ["-C", root, "fetch", "--quiet", "--no-tags", "origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/pull/*/head:refs/remotes/origin/pull/*"],
    { encoding: "utf8" },
  );
  if (run.error) return run.error.message;
  if (run.status !== 0) return (run.stderr.trim() || `git fetch exited ${run.status}`).split("\n")[0];
  return null;
}
