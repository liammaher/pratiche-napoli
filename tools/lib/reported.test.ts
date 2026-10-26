import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { addMonths, aggregate, markProblem, nextReported, sameReported, withReported, type ReviewedReport } from "./reported.ts";

const TODAY = "2026-10-26";
const DOCS = ["Mod. 1", "Visura"];
let n = 0;
const r = (extra: Partial<ReviewedReport> = {}): ReviewedReport => ({
  mark: (n++).toString(16).padStart(12, "0"),
  procedure: "napoli/comune/test",
  done: "2026-09",
  channel: "pec",
  outcome: "completata",
  ...extra,
});

test("fewer than 3 recent reports publish nothing", () => {
  assert.equal(aggregate([r(), r()], DOCS, TODAY), undefined);
  // Reports older than 12 months don't count: the window is 2025-11 to 2026-10.
  assert.equal(aggregate([r(), r(), r({ done: "2025-10" })], DOCS, TODAY), undefined);
  assert.equal(aggregate([r(), r(), r({ done: "2025-11" })], DOCS, TODAY)?.count, 3);
  assert.equal(addMonths("2026-10", -11), "2025-11");
  assert.equal(addMonths("2026-01", -1), "2025-12");
});

test("each figure needs 3 reports of its own, and so does what is left over", () => {
  const block = aggregate(
    [
      r({ days_to_answer: 9, paid_eur: 16, desk_wait_minutes: 30, documents: [{ name: "Mod. 1", asked: true }, { name: "Visura", asked: false }] }),
      r({ days_to_answer: 41, paid_eur: 16.5, documents: [{ name: "Mod. 1", asked: true }] }),
      r({ days_to_answer: 22, paid_eur: 17.2, desk_wait_minutes: 45, documents: [{ name: "Mod. 1", asked: true }, { name: "Visura", asked: true }] }),
      r({ days_to_answer: 23, channel: "desk", outcome: "respinta", documents: [{ name: "Altro", asked: true }] }),
      r({ channel: "desk", done: "2026-05" }),
      r({ channel: "desk", done: "2026-06" }),
    ],
    DOCS,
    TODAY,
  )!;
  // The window, not the first and last report's months.
  assert.deepEqual(block.period, { from: "2025-11", to: "2026-10" });
  assert.equal(block.count, 6);
  // 5 completed and 1 refused: publishing the 5 would give the refusal away.
  assert.equal(block.outcomes, undefined);
  // PEC 3 and desk 3; the desk has 1 answer about days, so none for it.
  assert.deepEqual(block.channels, [
    { type: "desk", count: 3 },
    { type: "pec", count: 3, days_to_answer: { median: 20, n: 3 } },
  ]);
  // Rounded medians (22 days to 20, 16,50 € to 15 €), never a smallest or largest value.
  assert.deepEqual(block.paid_eur, { median: 15, n: 3 });
  assert.equal(block.desk_wait_minutes, undefined); // only 2 answers
  // Visura was answered twice, "Altro" isn't a listed document.
  assert.deepEqual(block.documents, [{ name: "Mod. 1", asked: 3, of: 3 }]);
  assert.equal(block.basis.length, 6);
  assert.deepEqual(block.basis, [...block.basis].sort());
});

test("a figure isn't published when 1 or 2 of its total didn't answer", () => {
  // 3 at the desk said how long they waited, the fourth (by PEC) didn't: the
  // channels are held back, and the wait, whose 3 of 4 would point at the PEC one, too.
  const desk = (m: number) => r({ channel: "desk", desk_wait_minutes: m });
  const four = aggregate([desk(10), desk(20), desk(30), r()], DOCS, TODAY)!;
  assert.equal(four.channels, undefined);
  assert.equal(four.desk_wait_minutes, undefined);
  assert.deepEqual(aggregate([desk(10), desk(20), desk(30)], DOCS, TODAY)!.desk_wait_minutes, { median: 20, n: 3 });
  // Within a channel, the same for days.
  const pec = (d?: number) => r({ days_to_answer: d });
  assert.equal(aggregate([pec(10), pec(20), pec(30), pec()], DOCS, TODAY)!.channels![0].days_to_answer, undefined);
  // A document answered by 3 of 4.
  const doc = (asked?: boolean) => r(asked === undefined ? {} : { documents: [{ name: "Visura", asked }] });
  assert.equal(aggregate([doc(true), doc(true), doc(true), doc()], DOCS, TODAY)!.documents, undefined);
  // Rejection reasons only beside a published count of refusals.
  const refused = (reason: string) => r({ outcome: "respinta", rejection_reason: reason });
  const hidden = aggregate([refused("Manca la firma"), refused("Manca la firma"), refused("Manca la firma"), r(), r()], DOCS, TODAY)!;
  assert.equal(hidden.outcomes, undefined);
  assert.equal(hidden.rejection_reasons, undefined);
  const shown = aggregate([refused("Manca la firma"), refused("Manca la firma"), refused("Manca la firma"), r(), r(), r()], DOCS, TODAY)!;
  assert.deepEqual(shown.rejection_reasons, [{ text: "Manca la firma", count: 3 }]);
});

test("medians are rounded coarser as they grow", () => {
  const days = (...ds: number[]) => aggregate(ds.map((d) => r({ days_to_answer: d })), DOCS, TODAY)!.channels![0].days_to_answer!.median;
  assert.equal(days(2, 3, 4), 3);
  assert.equal(days(10, 23, 30), 25);
  assert.equal(days(40, 64, 90), 60);
  const paid = (...es: number[]) => aggregate(es.map((e) => r({ paid_eur: e })), DOCS, TODAY)!.paid_eur!.median;
  assert.equal(paid(16, 16, 16), 15);
  assert.equal(paid(200, 237, 300), 240);
  assert.equal(paid(1000, 1237, 2000), 1250);
});

test("counts held back so that the rest is never 1 or 2", () => {
  const outcomes = (...os: string[]) => aggregate(os.map((outcome) => r({ outcome })), DOCS, TODAY)!.outcomes;
  assert.deepEqual(outcomes("completata", "completata", "completata", "respinta", "respinta", "respinta"), { completata: 3, respinta: 3 });
  // 4 + 3 + 1: the 1 is left over, so the 3 is held back with it, making 4.
  assert.deepEqual(outcomes(...Array(4).fill("completata"), ...Array(3).fill("respinta"), "in_attesa"), { completata: 4 });
  assert.deepEqual(outcomes(...Array(3).fill("completata"), ...Array(3).fill("respinta"), "in_attesa", "rinunciato", "rinunciato"), {
    completata: 3,
    respinta: 3,
  });
});

test("a document's asked and not asked are each none or 3, one answer per report", () => {
  const ask = (...answers: boolean[][]) =>
    aggregate(answers.map((as) => r({ documents: as.map((asked) => ({ name: "Visura", asked })) })), DOCS, TODAY)!.documents;
  assert.deepEqual(ask([true], [true], [true]), [{ name: "Visura", asked: 3, of: 3 }]);
  assert.deepEqual(ask([false], [false], [false]), [{ name: "Visura", asked: 0, of: 3 }]);
  assert.equal(ask([true], [true], [true], [false]), undefined);
  // One report naming it three times is one answer.
  assert.equal(ask([true, true, true], [], []), undefined);
});

test("new reports come in together, 3 or more at a time", () => {
  const first = [r(), r(), r()];
  const old = aggregate(first, DOCS, TODAY)!;
  assert.deepEqual(nextReported([], first, DOCS, TODAY), { block: old });
  // One more report: comparing the two versions would describe it, so it waits.
  const one = nextReported([old], [...first, r({ outcome: "respinta" })], DOCS, TODAY);
  assert.ok(sameReported(one.block, old));
  assert.equal(one.note, "1 new report waits for 3 to come in together");
  // Three more: the new block.
  const three = nextReported([old], [...first, r(), r(), r()], DOCS, TODAY);
  assert.equal(three.note, undefined);
  assert.equal(three.block!.count, 6);
});

test("a figure holds in each group of reports the versions tell apart, not just in the whole", () => {
  // Found in review: 3 of 6 said what they paid; of 3 newcomers, 1 did. The
  // whole has 4 of 9, but n going from 3 to 4 says one newcomer answered, and
  // the median moving from 50 to 55 says about how much.
  const base = [r({ paid_eur: 10 }), r({ paid_eur: 50 }), r({ paid_eur: 90 }), r(), r(), r()];
  const v1 = aggregate(base, DOCS, TODAY)!;
  assert.deepEqual(v1.paid_eur, { median: 50, n: 3 });
  const v2 = nextReported([v1], [...base, r({ paid_eur: 62 }), r(), r()], DOCS, TODAY).block!;
  assert.equal(v2.count, 9);
  assert.equal(v2.paid_eur, undefined);
  // The same for outcomes: { completata: 3, respinta: 3 }, then { respinta: 4 }
  // would say one newcomer was refused. Completata 3 still holds: none of the
  // newcomers completed, which is 0 of them.
  const six = [r(), r(), r(), r({ outcome: "respinta" }), r({ outcome: "respinta" }), r({ outcome: "respinta" })];
  const w1 = aggregate(six, DOCS, TODAY)!;
  assert.deepEqual(w1.outcomes, { completata: 3, respinta: 3 });
  const newcomers = [r({ outcome: "respinta" }), r({ outcome: "rinunciato" }), r({ outcome: "rinunciato" })];
  assert.deepEqual(nextReported([w1], [...six, ...newcomers], DOCS, TODAY).block!.outcomes, { completata: 3 });
  // Three newcomers who all did the same are a group of their own, fine.
  const same = [r({ outcome: "respinta" }), r({ outcome: "respinta" }), r({ outcome: "respinta" })];
  assert.deepEqual(nextReported([w1], [...six, ...same], DOCS, TODAY).block!.outcomes, { completata: 3, respinta: 6 });
  // A document, a channel's days, and the desk wait likewise.
  const asked = (a?: boolean) => r(a === undefined ? {} : { documents: [{ name: "Visura", asked: a }] });
  const d1 = aggregate([asked(true), asked(true), asked(true)], DOCS, TODAY)!;
  const d2 = nextReported([d1], [asked(true), asked(true), asked(true), asked(false), asked(), asked()].map((x, i) => (i < 3 ? { ...x, mark: d1.basis[i] } : x)), DOCS, TODAY).block!;
  assert.equal(d2.count, 6);
  assert.equal(d2.documents, undefined);
});

test("reports published together leave together, however many versions are combined", () => {
  // 6 reports from November, then one (x) from December: 7. Six more: 13.
  // November leaves the window: if x stayed, the first version plus the last
  // minus the middle would be x alone. So x leaves with the November ones.
  const november = Array.from({ length: 6 }, (_, i) => r({ done: "2025-11", outcome: i < 3 ? "completata" : "respinta" }));
  const x = r({ done: "2025-12" });
  const later = Array.from({ length: 6 }, (_, i) => r({ done: "2026-03", outcome: i < 3 ? "completata" : "respinta" }));
  const v1 = nextReported([], [...november, x], DOCS, "2026-01-15").block!;
  const v2 = nextReported([v1], [...november, x, ...later], DOCS, "2026-04-01").block!;
  assert.equal(v2.count, 13);
  const v3 = nextReported([v1, v2], [...november, x, ...later], DOCS, "2026-11-02");
  assert.equal(v3.note, "1 report left with ones that are gone");
  assert.deepEqual(v3.block!.basis, later.map((l) => l.mark).sort());
  // A = 5, B = A + 3, then one of A's and two of B's are gone and a refusal
  // comes in: what is left of A and B leaves, and the refusal waits.
  const a = [r(), r(), r(), r(), r()];
  const b = [...a, r(), r(), r()];
  const vA = aggregate(a, DOCS, TODAY)!;
  const vB = nextReported([vA], b, DOCS, TODAY).block!;
  assert.equal(vB.count, 8);
  assert.deepEqual(nextReported([vA, vB], [...a.slice(1), b[7], r({ outcome: "respinta" })], DOCS, TODAY), {
    block: undefined,
    note: "5 reports left with ones that are gone; 1 new report waits for 3 to come in together",
  });
});

test("a report deleted on request takes the ones published with it out at once, and never comes back", () => {
  const [a, b, c, d] = [r(), r(), r(), r()];
  const v1 = aggregate([a, b, c, d], DOCS, TODAY)!;
  // d is deleted: a, b and c leave with it, so no version tells d apart.
  assert.deepEqual(nextReported([v1], [a, b, c], DOCS, TODAY), { block: undefined, note: "3 reports left with ones that are gone" });
  // Three new reports: a block of their own, without the old version.
  const fresh = [r(), r(), r()];
  const next = nextReported([v1], [a, b, c, ...fresh], DOCS, TODAY);
  assert.deepEqual(next.block!.basis, fresh.map((f) => f.mark).sort());
});

test("a cache of reports needs one valid mark per report", () => {
  assert.equal(markProblem([r(), r()]), undefined);
  assert.match(markProblem([r(), { ...r(), mark: undefined as unknown as string }])!, /a report without a mark \(null\) for napoli\/comune\/test: export the reports again/);
  assert.match(markProblem([r({ mark: "abc" })])!, /without a mark \("abc"\)/);
  const twice = r();
  assert.match(markProblem([twice, r(), { ...twice }])!, new RegExp(`the mark ${twice.mark} is on two reports`));
});

test("the maintainer's words: counts only from 3, tips kept once, newest first", () => {
  const block = aggregate(
    [
      r({ tip: "Mandare la PEC al mattino", extra_document: "Planimetria", done: "2026-07" }),
      r({ tip: "Portare due copie", extra_document: "Planimetria", rejection_reason: "Manca la firma", done: "2026-09" }),
      r({ tip: "Mandare la PEC al mattino", extra_document: "Planimetria", done: "2026-08" }),
      r({ extra_document: "Visura storica", done: "2026-08" }),
      r({ done: "2026-08" }),
      r({ done: "2026-08" }),
    ],
    DOCS,
    TODAY,
  )!;
  assert.deepEqual(block.extra_documents, [{ text: "Planimetria", count: 3 }]);
  // One text per report, so they divide the reports: 3 + 3 + 1 would give the
  // seventh away, and the smaller text is held back with it.
  const texts = (...ts: (string | undefined)[]) =>
    aggregate(ts.map((extra_document) => r({ extra_document })), DOCS, TODAY)!.extra_documents;
  assert.deepEqual(texts(...Array(3).fill("Planimetria"), ...Array(3).fill("Visura storica"), undefined), [{ text: "Planimetria", count: 3 }]);
  assert.deepEqual(texts(...Array(3).fill("Planimetria"), ...Array(3).fill("Visura storica")), [
    { text: "Planimetria", count: 3 },
    { text: "Visura storica", count: 3 },
  ]);
  // A reason one person gave would point at them.
  assert.equal(block.rejection_reasons, undefined);
  assert.deepEqual(block.tips, ["Portare due copie", "Mandare la PEC al mattino"]);
  // A blank tip is none: an empty one would make a block that doesn't validate.
  assert.equal(aggregate([r({ tip: "   " }), r(), r()], DOCS, TODAY)!.tips, undefined);
});

test("sameReported ignores when a block was generated", () => {
  const a = aggregate([r(), r(), r()], DOCS, TODAY)!;
  const b = { ...a, generated: "2026-10-30" };
  assert.ok(sameReported(a, b));
  assert.ok(!sameReported(a, aggregate([r(), r(), r(), r()], DOCS, TODAY)));
  assert.ok(sameReported(undefined, undefined));
  assert.ok(!sameReported(a, undefined));
});

const FILE = `schema_version: 0
id: napoli/comune/test # a comment
updated: 2026-10-01
summary: >-
  Un testo lungo che va a capo
  su più righe.
run_log:
  - { date: 2026-10-01, note: Primo caso }
`;

test("the block is appended, replaced or removed without touching the rest", () => {
  const block = aggregate([r(), r(), r({ days_to_answer: 5 })], DOCS, TODAY)!;
  const added = withReported(FILE, block, TODAY);
  assert.ok(added.startsWith(FILE.replace("updated: 2026-10-01", `updated: ${TODAY}`)));
  assert.match(added, /# Generated by npm run reports:aggregate/);
  assert.deepEqual(parse(added, { version: "1.2" }).reported, block);

  const smaller = { ...block, count: 4 };
  const replaced = withReported(added, smaller, "2026-10-27");
  assert.equal((replaced.match(/^reported:/gm) ?? []).length, 1);
  assert.equal((replaced.match(/# Generated by/g) ?? []).length, 1);
  assert.equal(parse(replaced, { version: "1.2" }).reported.count, 4);
  assert.match(replaced, /^updated: 2026-10-27$/m);

  const removed = withReported(replaced, undefined, "2026-10-28");
  assert.equal(removed, FILE.replace("updated: 2026-10-01", "updated: 2026-10-28"));
});
