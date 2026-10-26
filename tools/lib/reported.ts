// Turns reviewed reports into a procedure's `reported` block: what people who
// did it found, from the last 12 months. Every published number covers at
// least MIN reports, outcome and reason counts included, and so does what is
// left over beside the total it belongs to (the count, a channel's count, the
// refusals), unless nothing is: so no figure is one report's alone (though a
// count covering a whole group is true of each of its reports, which the
// privacy page says). A count whose total isn't published isn't either. Figures
// are rounded medians, never a smallest or largest value, which would be one
// person's. Every version of the block stays public in the history, and
// adding and subtracting versions gives the figures of any group of reports
// that exactly the same versions cover, as if that group were published on
// its own: so each figure is published only if it holds in every such group
// too (see nextReported).
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

// The block for one procedure, from all its reports as one group, or
// undefined when fewer than MIN fall in the window. `documents` are the
// procedure's listed document names.
export function aggregate(reports: ReviewedReport[], documents: string[], today: string): Reported | undefined {
  return figures([inWindow(reports, today)], documents, today);
}

// What earlier versions published about a group: the outcomes, channels and
// texts they gave counts for. Adding and subtracting versions gives the
// group's count of each, so what is left over beside them must hold too, in
// this version as in those, even where this one shows fewer.
interface Shown {
  outcomes: Set<string>;
  channels: Set<string>;
  extra: Set<string>;
  reasons: Set<string>;
}
const nothingShown = (): Shown => ({ outcomes: new Set(), channels: new Set(), extra: new Set(), reasons: new Set() });

// The block for `groups` of reports together, each figure published only if
// it holds in every group on its own; the whole is all of them, so it holds
// there too. `shown` is, for each group, what earlier versions published
// about it. Undefined when the groups have fewer than MIN reports.
function figures(groups: ReviewedReport[][], documents: string[], today: string, shown: Shown[] = groups.map(nothingShown)): Reported | undefined {
  const all = groups.flat();
  if (all.length < MIN) return undefined;
  const { from, to } = windowOf(today);
  // The period is the window itself: the first or last report's month would be one person's.
  const out = { generated: today, period: { from, to }, count: all.length } as Reported;

  const outcomes = new Map(safeCounts(groups, (r) => r.outcome, shown.map((s) => s.outcomes)));
  if (outcomes.size) out.outcomes = Object.fromEntries(OUTCOMES.flatMap((o) => (outcomes.has(o) ? [[o, outcomes.get(o)!]] : [])));

  const channels = safeCounts(groups, (r) => r.channel, shown.map((s) => s.channels)).map(([type, count]) => {
    const days = stat(
      groups.map((g) => g.filter((r) => r.channel === type)),
      (r) => r.days_to_answer,
      roundDays,
    );
    return { type, count, ...(days && { days_to_answer: days }) };
  });
  if (channels.length) out.channels = channels;

  const wait = stat(groups, (r) => r.desk_wait_minutes, (v) => Math.round(v / 5) * 5);
  if (wait) out.desk_wait_minutes = wait;
  const paid = stat(groups, (r) => r.paid_eur, roundEuros);
  if (paid) out.paid_eur = paid;

  // One answer per report and document, so a report listing a document twice
  // counts once. Who was asked, who wasn't, and who didn't say must each be
  // none or MIN.
  const docs = documents.flatMap((name) => {
    const answer = (r: ReviewedReport) => r.documents?.find((d) => d.name === name);
    const asked = all.filter((r) => answer(r)?.asked).length;
    const of = all.filter((r) => answer(r)).length;
    const ok =
      of >= MIN &&
      groups.every((g) => [true, false, undefined].every((a) => safe(g.filter((r) => answer(r)?.asked === a).length)));
    return ok ? [{ name, asked, of }] : [];
  });
  if (docs.length) out.documents = docs;

  // One text per report: the texts divide the reports, like the outcomes do.
  const extra = safeCounts(groups, (r) => r.extra_document?.trim() || undefined, shown.map((s) => s.extra)).map(([text, count]) => ({ text, count }));
  if (extra.length) out.extra_documents = extra;
  // Reasons only beside a published count of refusals, which they divide.
  const rejected = out.outcomes?.respinta ? groups.map((g) => g.filter((r) => r.outcome === "respinta")) : [];
  const reasons = safeCounts(rejected, (r) => r.rejection_reason?.trim() || undefined, shown.map((s) => s.reasons)).map(([text, count]) => ({ text, count }));
  if (reasons.length) out.rejection_reasons = reasons;
  // Newest first; the same tip written twice is shown once.
  const tips = [...new Set([...all].sort((a, b) => b.done.localeCompare(a.done)).flatMap((r) => (r.tip?.trim() ? [r.tip.trim()] : [])))];
  if (tips.length) out.tips = tips;

  out.basis = all.map((r) => r.mark).sort();
  return out;
}

// What the procedure's block becomes. `published` is every version of it ever
// published, the one in the procedure now included: all are public in the
// repository's history. Adding and subtracting versions gives the figures of
// any group of reports that exactly the same versions cover, as if it were
// published alone, and of any number of such groups together. So:
// - a group stays in the figures only whole: once one of its reports is gone
//   (deleted on request, or out of the window), the others leave with it,
//   and as the group is never split, nothing tells the gone one apart;
// - reports in no version yet come in as one new group, once there are MIN;
// - each figure is published only if it holds in every group on its own.
// Then no figure that versions can give, however they are combined, rests on
// 1 or 2 reports. `note` says which reports were left out.
export function nextReported(
  published: Reported[],
  reports: ReviewedReport[],
  documents: string[],
  today: string,
): { block: Reported | undefined; note?: string } {
  const recent = new Map(inWindow(reports, today).map((r) => [r.mark, r]));
  const versions = published.map((v) => new Set(v.basis ?? []));
  const marks = new Set(versions.flatMap((v) => [...v]));
  const covered = group([...marks], (mark) => versions.map((v) => (v.has(mark) ? 1 : 0)).join(""));
  const kept: ReviewedReport[][] = [];
  const shown: Shown[] = [];
  let left = 0;
  for (const ms of covered.values()) {
    const rs = ms.flatMap((m) => recent.get(m) ?? []);
    if (rs.length === ms.length && rs.length >= MIN) {
      kept.push(rs);
      // The versions that covered this group (all of it: it is a group).
      const covering = published.filter((_, i) => versions[i].has(ms[0]));
      shown.push({
        outcomes: new Set(covering.flatMap((v) => Object.keys(v.outcomes ?? {}))),
        channels: new Set(covering.flatMap((v) => (v.channels ?? []).map((c) => c.type))),
        extra: new Set(covering.flatMap((v) => (v.extra_documents ?? []).map((d) => d.text))),
        reasons: new Set(covering.flatMap((v) => (v.rejection_reasons ?? []).map((d) => d.text))),
      });
    } else left += rs.length;
  }
  const fresh = [...recent.values()].filter((r) => !marks.has(r.mark));
  const waiting = fresh.length < MIN ? fresh.length : 0;
  const notes = [
    left && `${left} ${left === 1 ? "report left" : "reports left"} with ones that are gone`,
    waiting && `${waiting} new ${waiting === 1 ? "report waits" : "reports wait"} for ${MIN} to come in together`,
  ].filter(Boolean);
  return {
    block: waiting || !fresh.length ? figures(kept, documents, today, shown) : figures([...kept, fresh], documents, today, [...shown, nothingShown()]),
    ...(notes.length && { note: notes.join("; ") }),
  };
}

// What `npm run reports -- export` writes: the accepted reports, and when.
export interface ReportsCache {
  exported: string; // ISO time
  reports: ReviewedReport[];
}

// How long an export can be used. A report deleted, rejected or accepted
// again with other words after it was exported is still in it as it was, so
// an old export would bring a deleted report back into the figures.
export const CACHE_MAX_MINUTES = 60;

// Whether `cache` is an export at all (so it can be removed once read), and
// why it can't be used now, or undefined when it can.
export function cacheProblem(cache: unknown, now: Date): { export: boolean; problem?: string } {
  const c = cache as Partial<ReportsCache> | undefined;
  if (Array.isArray(cache)) return { export: false, problem: "an export from before exports were dated: export the reports again" };
  if (!c || typeof c !== "object" || typeof c.exported !== "string" || !Array.isArray(c.reports)) return { export: false, problem: "not an export of the reports" };
  const age = (now.getTime() - Date.parse(c.exported)) / 60_000;
  if (!(age >= 0)) return { export: true, problem: `exported at ${c.exported}, which isn't a time before now: export the reports again` };
  if (age > CACHE_MAX_MINUTES) return { export: true, problem: `exported ${Math.ceil(age)} minutes ago, more than ${CACHE_MAX_MINUTES}: a report deleted or changed since would be in it as it was. Export the reports again` };
  return { export: true };
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

// A count that can be published, or left as the remainder: none, or MIN or more.
const safe = (n: number) => n === 0 || n >= MIN;

// The counts of `key` that can be published: each none or at least MIN in
// every group, and what they leave over in each group too, beside them and
// beside the keys earlier versions showed for that group (`shown`, one set
// per group). While a group's remainder is 1 or 2, the smallest count is
// held back with it. A report whose key is undefined is only ever part of
// the remainder.
function safeCounts(
  groups: ReviewedReport[][],
  key: (r: ReviewedReport) => string | undefined,
  shown: Set<string>[] = groups.map(() => new Set()),
): [string, number][] {
  const count = (rs: ReviewedReport[], k: string) => rs.filter((r) => key(r) === k).length;
  const all = groups.flat();
  const kept = [...new Set(all.flatMap((r) => key(r) ?? []))]
    .filter((k) => groups.every((g) => safe(count(g, k))))
    .map((k): [string, number] => [k, count(all, k)])
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b, "it"));
  const rest = (g: ReviewedReport[], i: number) =>
    g.length - [...new Set([...kept.map(([k]) => k), ...shown[i]])].reduce((sum, k) => sum + count(g, k), 0);
  while (kept.length && !groups.every((g, i) => safe(rest(g, i)))) kept.pop();
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
// of the report in the middle, or nothing when, in some group, 1 or 2
// answered or 1 or 2 didn't.
function stat(groups: ReviewedReport[][], value: (r: ReviewedReport) => number | undefined, round: (v: number) => number): Stat | undefined {
  const answered = (g: ReviewedReport[]) => g.filter((r) => typeof value(r) === "number");
  if (!groups.every((g) => safe(answered(g).length) && safe(g.length - answered(g).length))) return undefined;
  const xs = answered(groups.flat()).map((r) => value(r)!).sort((a, b) => a - b);
  if (xs.length < MIN) return undefined;
  const mid = xs.length / 2;
  const median = xs.length % 2 ? xs[Math.floor(mid)] : (xs[mid - 1] + xs[mid]) / 2;
  return { median: round(median), n: xs.length };
}

const to = (step: number) => (v: number) => Math.round(v / step) * step;
// Coarser the longer it is: 3 days stays 3, 23 becomes 25, 47 becomes 50.
const roundDays = (v: number) => (v < 7 ? Math.round(v) : v < 60 ? to(5)(v) : to(10)(v));
// 16,50 € becomes 15 €, 66 € 65 €, 1.237 € 1.250 €.
const roundEuros = (v: number) => (v < 100 ? to(5)(v) : v < 1000 ? to(10)(v) : to(50)(v));

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

