// Turns reviewed reports into a procedure's `reported` block: what people who
// did it found, from the last 12 months. Every published number covers at
// least MIN reports, outcome and reason counts included, and so does what is
// left over beside the total it belongs to (the count, a channel's count, the
// refusals), unless nothing is: so no one person's result can be singled out
// or worked out. A count whose total isn't published isn't either. Figures
// are rounded medians, never a smallest or largest value, which would be one
// person's. A block only changes when, across every version published before
// it (all public, in the history), the reports still fall in groups of MIN or
// more, so comparing versions doesn't single anyone out either.
// Tips, rejection reasons and extra documents are a maintainer's words,
// written at review time, never a report's.

import { stringify } from "yaml";
import { canonical } from "./updated.ts";

export const MIN = 3;
export const WINDOW_MONTHS = 12;

const OUTCOMES = ["completata", "chiesto_altro", "respinta", "in_attesa", "rinunciato"] as const;

// An accepted report as `npm run reports -- export` writes it: the fields the
// figures need, without the person's own free text or contact.
export interface ReviewedReport {
  // A random token the backend gave the report, unrelated to its id (the
  // person's receipt): what stands for it in the public `basis`.
  mark: string;
  procedure: string;
  done: string; // YYYY-MM
  channel: string;
  outcome: string;
  days_to_answer?: number;
  desk_wait_minutes?: number;
  paid_eur?: number;
  documents?: { name: string; asked: boolean }[];
  tip?: string;
  rejection_reason?: string;
  extra_document?: string;
}

export interface Stat {
  median: number;
  n: number;
}

export interface Reported {
  generated: string;
  period: { from: string; to: string };
  count: number;
  outcomes?: Partial<Record<(typeof OUTCOMES)[number], number>>;
  channels?: { type: string; count: number; days_to_answer?: Stat }[];
  desk_wait_minutes?: Stat;
  paid_eur?: Stat;
  documents?: { name: string; asked: number; of: number }[];
  extra_documents?: { text: string; count: number }[];
  rejection_reasons?: { text: string; count: number }[];
  tips?: string[];
  // the mark of each report behind the block, so the next update can tell
  // which reports each version covered
  basis: string[];
}

// The block for one procedure, or undefined when fewer than MIN reports fall
// in the window. `documents` are the procedure's listed document names.
export function aggregate(reports: ReviewedReport[], documents: string[], today: string): Reported | undefined {
  const { from, to } = windowOf(today);
  const recent = inWindow(reports, today);
  if (recent.length < MIN) return undefined;

  // The period is the window itself: the first or last report's month would be one person's.
  const out = { generated: today, period: { from, to }, count: recent.length } as Reported;

  const outcomes = safeCounts(OUTCOMES.map((o) => [o, recent.filter((r) => r.outcome === o).length]), recent.length);
  if (outcomes.length) out.outcomes = Object.fromEntries(outcomes);

  const byChannel = group(recent, (r) => r.channel);
  const channels = safeCounts([...byChannel].map(([type, rs]) => [type, rs.length]), recent.length)
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([type, count]) => {
      const days = stat(byChannel.get(type)!.map((r) => r.days_to_answer), count, roundDays);
      return { type, count, ...(days && { days_to_answer: days }) };
    });
  if (channels.length) out.channels = channels;

  const wait = stat(recent.map((r) => r.desk_wait_minutes), recent.length, (v) => Math.round(v / 5) * 5);
  if (wait) out.desk_wait_minutes = wait;
  const paid = stat(recent.map((r) => r.paid_eur), recent.length, roundEuros);
  if (paid) out.paid_eur = paid;

  // One answer per report and document, so a report listing a document twice
  // counts once. Who was asked, who wasn't, and who didn't say must each be
  // none or MIN.
  const docs = documents.flatMap((name) => {
    const answers = recent.flatMap((r) => (r.documents ?? []).filter((d) => d.name === name).slice(0, 1));
    const asked = answers.filter((d) => d.asked).length;
    const ok = answers.length >= MIN && safe(asked) && safe(answers.length - asked) && safe(recent.length - answers.length);
    return ok ? [{ name, asked, of: answers.length }] : [];
  });
  if (docs.length) out.documents = docs;

  const extra = counted(recent.map((r) => r.extra_document)).filter((t) => safe(recent.length - t.count));
  if (extra.length) out.extra_documents = extra;
  // Reasons only beside a published count of refusals, which they divide.
  const rejected = out.outcomes?.respinta ? recent.filter((r) => r.outcome === "respinta") : [];
  const reasons = safeCounts(
    counted(rejected.map((r) => r.rejection_reason)).map((t) => [t.text, t.count]),
    rejected.length,
  ).map(([text, count]) => ({ text, count }));
  if (reasons.length) out.rejection_reasons = reasons;
  // Newest first; the same tip written twice is shown once.
  const tips = [...new Set([...recent].sort((a, b) => b.done.localeCompare(a.done)).flatMap((r) => (r.tip ? [r.tip.trim()] : [])))];
  if (tips.length) out.tips = tips;

  out.basis = recent.map((r) => r.mark).sort();
  return out;
}

// What the procedure's block becomes. `history` is every version of it ever
// published, in any order: all are public in the repository's history.
// `current` is the block in the procedure now, if it has one. Adding and
// subtracting versions' figures can describe any group of reports that
// exactly the same versions cover, so the new block replaces the current one
// only if, across all of them and it, every such group has at least MIN
// reports. Comparing two versions at a time isn't enough: 7, then 13, then 7
// reports again can each move by 6, yet the first plus the last minus the
// middle is the one report in all three. Otherwise the current block stays,
// for at most MAX_HOLD_DAYS: after that it is removed (publishing nothing
// gives nothing away), so a report deleted on request or gone from the window
// doesn't stay in the figures for long. A procedure without a block keeps
// none: an older version is never brought back. `held` says why.
export function nextReported(
  history: Reported[],
  current: Reported | undefined,
  reports: ReviewedReport[],
  documents: string[],
  today: string,
): { block: Reported | undefined; held?: string } {
  const block = aggregate(reports, documents, today);
  if (!block) return { block: undefined };
  const versions = [...history, ...(current ? [current] : []), block].map((v) => new Set(v.basis ?? []));
  const groups = group([...new Set(versions.flatMap((v) => [...v]))], (mark) => versions.map((v) => (v.has(mark) ? 1 : 0)).join(""));
  const smallest = Math.min(...[...groups.values()].map((g) => g.length));
  if (safe(smallest)) return { block };
  const why = `${smallest} ${smallest === 1 ? "report" : "reports"} would stand apart between published versions`;
  if (current && dayNumber(today) - dayNumber(current.generated) <= MAX_HOLD_DAYS) return { block: current, held: `${why}; kept as it is` };
  return { block: undefined, held: `${why}; ${current ? "removed until it can change" : "none until it can be"}` };
}

// Marks a cache of reports must have: one each, unique, as the backend makes
// them. An export from before marks, or two caches merged, would otherwise
// give a basis that groups the wrong reports. The problem, or undefined.
export function markProblem(reports: ReviewedReport[]): string | undefined {
  const bad = reports.find((r) => typeof r.mark !== "string" || !/^[0-9a-f]{12}$/.test(r.mark));
  if (bad) return `a report without a mark (${JSON.stringify(bad.mark ?? null)}) for ${bad.procedure}: export the reports again`;
  const seen = new Set<string>();
  const twice = reports.find((r) => seen.size === seen.add(r.mark).size);
  return twice ? `the mark ${twice.mark} is on two reports: export the reports again` : undefined;
}

export const MAX_HOLD_DAYS = 90;
const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

// A count that can be published, or left as the remainder: none, or MIN or more.
const safe = (n: number) => n === 0 || n >= MIN;

// The counts that can be published next to `total`: each at least MIN, and
// what they leave over too, unless nothing is left. While the remainder is
// 1 or 2, the smallest count is held back with it.
function safeCounts(counts: [string, number][], total: number): [string, number][] {
  const kept = counts.filter(([, n]) => n >= MIN).sort(([, a], [, b]) => b - a);
  const rest = () => total - kept.reduce((sum, [, n]) => sum + n, 0);
  while (kept.length && !safe(rest())) kept.pop();
  return kept;
}

function windowOf(today: string): { from: string; to: string } {
  const to = today.slice(0, 7);
  return { from: addMonths(to, -(WINDOW_MONTHS - 1)), to };
}

function inWindow(reports: ReviewedReport[], today: string): ReviewedReport[] {
  const { from, to } = windowOf(today);
  return reports.filter((r) => r.done >= from && r.done <= to);
}

// Whether two blocks say the same, apart from when they were generated.
export function sameReported(a: Reported | undefined, b: Reported | undefined): boolean {
  const strip = (r?: Reported) => (r ? { ...r, generated: undefined } : undefined);
  return canonical(strip(a)) === canonical(strip(b));
}

const HEADER = "# Generated by npm run reports:aggregate from reviewed reports; don't edit by hand.";

// Rewrites a procedure file's text with `block` as its last top-level key (or
// without one), touching nothing else but `updated`. Text-level, because
// re-serialising the whole document would refold every long text.
export function withReported(text: string, block: Reported | undefined, updated: string): string {
  const lines = text.replace(/\n*$/, "\n").split("\n");
  const start = lines.findIndex((l) => /^reported:/.test(l));
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && (lines[end] === "" || /^[\s#]/.test(lines[end]))) end++;
    const from = start > 0 && lines[start - 1] === HEADER ? start - 1 : start;
    lines.splice(from, end - from);
  }
  let out = lines.join("\n").replace(/\n*$/, "\n");
  if (block) out += `${HEADER}\n${stringify({ reported: block }, { lineWidth: 0 })}`;
  return out.replace(/^updated: .*$/m, `updated: ${updated}`);
}

// The median of the answers, rounded so it doesn't give away the exact figure
// of the report in the middle, or nothing when fewer than MIN answered or
// those who didn't (out of `total`) are 1 or 2.
function stat(values: (number | undefined)[], total: number, round: (v: number) => number): Stat | undefined {
  const xs = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  if (xs.length < MIN || !safe(total - xs.length)) return undefined;
  const mid = xs.length / 2;
  const median = xs.length % 2 ? xs[Math.floor(mid)] : (xs[mid - 1] + xs[mid]) / 2;
  return { median: round(median), n: xs.length };
}

const to = (step: number) => (v: number) => Math.round(v / step) * step;
// Coarser the longer it is: 3 days stays 3, 23 becomes 25, 47 becomes 50.
const roundDays = (v: number) => (v < 7 ? Math.round(v) : v < 60 ? to(5)(v) : to(10)(v));
// 16,50 € becomes 15 €, 66 € 65 €, 1.237 € 1.250 €.
const roundEuros = (v: number) => (v < 100 ? to(5)(v) : v < 1000 ? to(10)(v) : to(50)(v));

// Only texts at least MIN reports share.
function counted(texts: (string | undefined)[]): { text: string; count: number }[] {
  return [...group(texts.flatMap((t) => (t?.trim() ? [t.trim()] : [])), (t) => t)]
    .map(([text, ts]) => ({ text, count: ts.length }))
    .filter((t) => t.count >= MIN)
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, "it"));
}

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(key(item), [...(out.get(key(item)) ?? []), item]);
  return out;
}

// "2026-10" plus -11 months is "2025-11".
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const total = y * 12 + (m - 1) + n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

