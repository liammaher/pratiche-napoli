// The rule behind `updated`: a procedure whose content changed must carry an
// `updated` date on or after the day of the change, and the date never goes
// backwards. Content means the parsed data without `updated` itself, so YAML
// comments, layout and key order don't count as changes.

type Data = Record<string, unknown>;

export function contentChanged(before: Data, after: Data): boolean {
  const { updated: _b, ...a } = before;
  const { updated: _a, ...b } = after;
  return canonical(a) !== canonical(b);
}

// `before` is the procedure at the base commit, or undefined for a new file;
// `changedOn` is the day of the latest change (YYYY-MM-DD, Rome time).
export function checkUpdated(before: Data | undefined, after: Data, changedOn: string): string | null {
  if (before && !contentChanged(before, after)) return null;
  const now = typeof after.updated === "string" ? after.updated : undefined;
  if (!now) return "has no updated date";
  const was = typeof before?.updated === "string" ? before.updated : undefined;
  if (was && now < was) return `updated went backwards, from ${was} to ${now}`;
  if (now < changedOn) return `changed on ${changedOn} but updated is still ${now}: set it to ${changedOn}`;
  return null;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Data)[k]]))
      : v,
  );
}
