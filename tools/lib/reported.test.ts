import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "yaml";
import { addMonths, aggregate, fingerprint, nextReported, sameReported, withReported, type ReviewedReport } from "./reported.ts";

const TODAY = "2026-10-26";
const DOCS = ["Mod. 1", "Visura"];
let n = 0;
const r = (extra: Partial<ReviewedReport> = {}): ReviewedReport => ({
  id: `r${n++}`,
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
    { type: "pec", count: 3, days_to_answer: { median: 22, n: 3 } },
  ]);
  // A median rounded to whole euros, never a smallest or largest value.
  assert.deepEqual(block.paid_eur, { median: 17, n: 3 });
  assert.equal(block.desk_wait_minutes, undefined); // only 2 answers
  // Visura was answered twice, "Altro" isn't a listed document.
  assert.deepEqual(block.documents, [{ name: "Mod. 1", asked: 3, of: 3 }]);
  assert.equal(block.basis.length, 6);
  assert.deepEqual(block.basis, [...block.basis].sort());
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

test("a block changes only when at least 3 reports came in or dropped out", () => {
  const first = [r(), r(), r()];
  const old = aggregate(first, DOCS, TODAY)!;
  assert.deepEqual(nextReported(undefined, first, DOCS, TODAY), { block: old });
  // One more report: comparing the two versions would describe it.
  const one = nextReported(old, [...first, r({ outcome: "respinta" })], DOCS, TODAY);
  assert.equal(one.block, old);
  assert.match(one.held!, /1 new and 0 dropped/);
  // Three more: the new block.
  const three = nextReported(old, [...first, r(), r(), r()], DOCS, TODAY);
  assert.equal(three.held, undefined);
  assert.equal(three.block!.count, 6);
  // One aging out is held too, and so is the block's removal it would cause.
  const aged = nextReported(old, [first[0], first[1], { ...first[2], done: "2025-01" }], DOCS, TODAY);
  assert.equal(aged.block, old);
  // All three gone: the block goes.
  assert.deepEqual(nextReported(old, [], DOCS, TODAY), { block: undefined });
  assert.match(fingerprint("abc"), /^[0-9a-f]{12}$/);
});

test("the maintainer's words: counts only from 3, tips kept once, newest first", () => {
  const block = aggregate(
    [
      r({ tip: "Mandare la PEC al mattino", extra_document: "Planimetria", done: "2026-07" }),
      r({ tip: "Portare due copie", extra_document: "Planimetria", rejection_reason: "Manca la firma", done: "2026-09" }),
      r({ tip: "Mandare la PEC al mattino", extra_document: "Planimetria", done: "2026-08" }),
      r({ extra_document: "Visura storica", done: "2026-08" }),
    ],
    DOCS,
    TODAY,
  )!;
  assert.deepEqual(block.extra_documents, [{ text: "Planimetria", count: 3 }]);
  // A reason one person gave would point at them.
  assert.equal(block.rejection_reasons, undefined);
  assert.deepEqual(block.tips, ["Portare due copie", "Mandare la PEC al mattino"]);
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
