// Turns reviewed reports into a procedure's `reported` block: what people who
// did it found, from the last 12 months. Every published number covers at
// least MIN reports, outcome and reason counts included, and so does what is
// left over beside them (the total minus the published counts), so no one
// person's result can be singled out or worked out. Figures are medians,
// never a smallest or largest value, which would be one person's. A block
// only changes when at least MIN reports came in or dropped out since the
// last one, so comparing two versions doesn't single anyone out either.
// Tips, rejection reasons and extra documents are a maintainer's words,
// written at review time, never a report's.

import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { canonical } from "./updated.ts";

export const MIN = 3;
export const WINDOW_MONTHS = 12;

const OUTCOMES = ["completata", "chiesto_altro", "respinta", "in_attesa", "rinunciato"] as const;

// An accepted report as `npm run reports -- export` writes it: the fields the
// figures need, without the person's own free text or contact.
export interface ReviewedReport {
  id: string;
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
  // fingerprint() of each report behind the block, so the next update knows
  // how many came in or dropped out
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
      const days = stat(byChannel.get(type)!.map((r) => r.days_to_answer), 1);
      return { type, count, ...(days && { days_to_answer: days }) };
    });
  if (channels.length) out.channels = channels;

  const wait = stat(recent.map((r) => r.desk_wait_minutes), 5);
  if (wait) out.desk_wait_minutes = wait;
  const paid = stat(recent.map((r) => r.paid_eur), 1);
  if (paid) out.paid_eur = paid;

  // One answer per report and document, so a report listing a document twice
  // counts once; both who was asked and who wasn't must be none or MIN.
  const docs = documents.flatMap((name) => {
    const answers = recent.flatMap((r) => (r.documents ?? []).filter((d) => d.name === name).slice(0, 1));
    const asked = answers.filter((d) => d.asked).length;
    return answers.length >= MIN && safe(asked) && safe(answers.length - asked) ? [{ name, asked, of: answers.length }] : [];
  });
  if (docs.length) out.documents = docs;

  const extra = counted(recent.map((r) => r.extra_document));
  if (extra.length) out.extra_documents = extra;
  const rejected = recent.filter((r) => r.outcome === "respinta");
  const reasons = safeCounts(
    counted(rejected.map((r) => r.rejection_reason)).map((t) => [t.text, t.count]),
    rejected.length,
  ).map(([text, count]) => ({ text, count }));
  if (reasons.length) out.rejection_reasons = reasons;
  // Newest first; the same tip written twice is shown once.
  const tips = [...new Set([...recent].sort((a, b) => b.done.localeCompare(a.done)).flatMap((r) => (r.tip ? [r.tip.trim()] : [])))];
  if (tips.length) out.tips = tips;

  out.basis = recent.map((r) => fingerprint(r.id)).sort();
  return out;
}

// What the procedure's block becomes: the new one, or the old one kept while
// fewer than MIN reports came in or dropped out since it, because the
// difference between two versions (both public, in the history) would
// describe those few reports. `held` says why the old block stays.
export function nextReported(
  old: Reported | undefined,
  reports: ReviewedReport[],
  documents: string[],
  today: string,
): { block: Reported | undefined; held?: string } {
  const block = aggregate(reports, documents, today);
  if (!old?.basis) return { block };
  const now = new Set(inWindow(reports, today).map((r) => fingerprint(r.id)));
  const before = new Set(old.basis);
  const added = [...now].filter((f) => !before.has(f)).length;
  const dropped = [...before].filter((f) => !now.has(f)).length;
  if (safe(added) && safe(dropped)) return { block };
  return { block: old, held: `${added} new and ${dropped} dropped reports since the last block; waiting for ${MIN} of each` };
}

// A report's mark in the public block: part of the hash of its private
// database id, which can't be traced back without the database.
export function fingerprint(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 12);
}

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

// The median, rounded to a multiple of `step` (whole euros, 5 minutes), so it
// doesn't give away the exact figure of the report in the middle.
function stat(values: (number | undefined)[], step: number): Stat | undefined {
  const xs = values.filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  if (xs.length < MIN) return undefined;
  const mid = xs.length / 2;
  const median = xs.length % 2 ? xs[Math.floor(mid)] : (xs[mid - 1] + xs[mid]) / 2;
  return { median: Math.round(median / step) * step, n: xs.length };
}

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

