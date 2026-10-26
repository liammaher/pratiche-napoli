// The maintainer's review commands against the Firestore emulator: npm run test:emulator.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { accept, describe, exportAccepted, exportPath, findByEmail, list, reject, remove, show } from "../scripts/review";

const PROJECT = "demo-pratiche-napoli";
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
if (!EMULATOR) throw new Error("FIRESTORE_EMULATOR_HOST is not set: run npm run test:emulator");

const db = getFirestore(initializeApp({ projectId: PROJECT }, "review"));

const report = (procedure: string, minute: number, extra: Record<string, unknown> = {}) => ({
  procedure,
  source: "web",
  done: "2026-09",
  channel: "pec",
  office: "PEC",
  outcome: "completata",
  days_to_answer: 20,
  note: "testo della persona",
  claim_feedback: [{ section: "scadenza", verdict: "sbagliata", text: "testo" }],
  status: "pending",
  received_at: Timestamp.fromDate(new Date(Date.UTC(2026, 9, 20, 10, minute))),
  mark: `${procedure.slice(-1)}${minute}`.padStart(12, "0"),
  ...extra,
});

beforeEach(async () => {
  const res = await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  assert.ok(res.ok, `clearing the emulator: HTTP ${res.status}`);
  await db.doc("reports/b2").set(report("napoli/comune/b", 2));
  await db.doc("reports/a1").set(report("napoli/comune/a", 5, { consent_contact: true, pii_redacted: true }));
  await db.doc("reports/b1").set(report("napoli/comune/b", 1));
  await db.doc("reports/done").set(report("napoli/comune/a", 0, { status: "accepted", tip: "Portare la visura" }));
  await db.doc("contacts/a1").set({ contact_email: "persona@example.org" });
});

test("pending reports come grouped by procedure, oldest first", async () => {
  assert.deepEqual((await list(db)).map((r) => r.id), ["a1", "b1", "b2"]);
  const text = describe((await list(db))[0]);
  assert.match(text, /a1 {2}2026-09 · pec \(PEC\) · completata · 20 giorni · DATI PERSONALI RIMOSSI/);
  assert.match(text, /segnala scadenza: sbagliata – testo/);
  assert.match(text, /si può ricontattare/);
  assert.doesNotMatch(text, /persona@example\.org/);
});

test("show gives the report and, if there is one, its contact", async () => {
  const { report: r, contact } = await show(db, "a1");
  assert.equal(r?.procedure, "napoli/comune/a");
  assert.equal(contact, "persona@example.org");
  assert.equal((await show(db, "b1")).contact, undefined);
  await assert.rejects(show(db, "nope"), /no report nope/);
});

test("once the report has expired, its contact can still be shown and deleted", async () => {
  await db.doc("reports/a1").delete();
  assert.deepEqual(await show(db, "a1"), { report: undefined, contact: "persona@example.org" });
  await remove(db, "a1");
  assert.equal((await db.doc("contacts/a1").get()).exists, false);
});

test("accept records the maintainer's words; reject and unknown ids", async () => {
  const at = new Date("2026-10-26T09:00:00Z");
  await accept(db, "b1", { tip: "Mandare la PEC al mattino", extra_document: "Planimetria" }, at);
  const b1 = (await db.doc("reports/b1").get()).data()!;
  assert.equal(b1.status, "accepted");
  assert.equal(b1.tip, "Mandare la PEC al mattino");
  assert.equal(b1.extra_document, "Planimetria");
  assert.equal(b1.rejection_reason, undefined);
  assert.equal(b1.reviewed_at.toDate().toISOString(), at.toISOString());

  await reject(db, "b2", at);
  assert.equal((await db.doc("reports/b2").get()).data()!.status, "rejected");
  assert.deepEqual((await list(db)).map((r) => r.id), ["a1"]);

  await assert.rejects(accept(db, "nope", {}), /no report nope/);
  await assert.rejects(accept(db, "a1", { tip: " " }), /tip must be 1–300 characters, or empty to remove it/);
  await assert.rejects(accept(db, "a1", { tip: "x".repeat(301) }), /tip must be/);
});

test("find gives the reports of someone who left their email", async () => {
  assert.deepEqual(await findByEmail(db, " persona@example.org "), ["a1"]);
  assert.deepEqual(await findByEmail(db, "Persona@Example.ORG"), ["a1"]);
  assert.deepEqual(await findByEmail(db, "altra@example.org"), []);
});

test("delete removes the report and its contact", async () => {
  await remove(db, "a1");
  assert.equal((await db.doc("reports/a1").get()).exists, false);
  assert.equal((await db.doc("contacts/a1").get()).exists, false);
  await assert.rejects(remove(db, "a1"), /no report a1/);
});

test("export has only accepted reports, without the person's text, contact or receipt", async () => {
  await accept(db, "b1", { rejection_reason: "Manca la firma" });
  const out = await exportAccepted(db);
  // By procedure, then month.
  assert.deepEqual(out.map((r) => r.mark), ["0000000000a0", "0000000000b1"]);
  for (const r of out) {
    for (const hidden of ["id", "note", "claim_feedback", "office", "contact_email", "consent_contact", "status", "received_at"]) {
      assert.equal(r[hidden], undefined, hidden);
    }
  }
  assert.deepEqual(out[0], {
    mark: "0000000000a0",
    procedure: "napoli/comune/a",
    done: "2026-09",
    channel: "pec",
    outcome: "completata",
    days_to_answer: 20,
    tip: "Portare la visura",
  });
  assert.equal(out[1].rejection_reason, "Manca la firma");
});

test("export refuses an accepted report without a mark; accepting gives it one", async () => {
  await db.doc("reports/done").update({ mark: FieldValue.delete() });
  await assert.rejects(exportAccepted(db), /report done has no mark/);
  await accept(db, "done", {});
  assert.match((await db.doc("reports/done").get()).data()!.mark, /^[0-9a-f]{12}$/);
  // An existing mark is kept.
  await accept(db, "b1", {});
  assert.equal((await db.doc("reports/b1").get()).data()!.mark, "0000000000b1");
  assert.equal((await exportAccepted(db)).length, 2);
});

test("accepting again changes the maintainer's fields; an empty one is removed", async () => {
  await accept(db, "b1", { tip: "Portare la visura stroica", extra_document: "Planimetria" });
  const mark = (await db.doc("reports/b1").get()).data()!.mark;
  // The same words again change nothing, the mark included.
  await accept(db, "b1", { extra_document: "Planimetria" });
  assert.equal((await db.doc("reports/b1").get()).data()!.mark, mark);
  // Other words make it a new report to the figures: a new mark.
  await accept(db, "b1", { tip: "Portare la visura storica" });
  let b1 = (await db.doc("reports/b1").get()).data()!;
  assert.equal(b1.tip, "Portare la visura storica");
  assert.equal(b1.extra_document, "Planimetria");
  assert.notEqual(b1.mark, mark);
  assert.match(b1.mark, /^[0-9a-f]{12}$/);
  await accept(db, "b1", { extra_document: "" });
  b1 = (await db.doc("reports/b1").get()).data()!;
  assert.equal("extra_document" in b1, false);
  assert.equal(b1.tip, "Portare la visura storica");
  // Removing a field that isn't there changes nothing either.
  const kept = b1.mark;
  await accept(db, "b1", { extra_document: "" });
  assert.equal((await db.doc("reports/b1").get()).data()!.mark, kept);
});

test("list --accepted shows accepted reports with the maintainer's fields", async () => {
  const accepted = await list(db, "accepted");
  assert.deepEqual(accepted.map((r) => r.id), ["done"]);
  assert.match(describe(accepted[0]), /tip: Portare la visura/);
});

test("export writes where the command was run from, or to the repo root", () => {
  assert.equal(exportPath("tmp/cache.json", "/repo", "/repo"), "/repo/tmp/cache.json");
  assert.equal(exportPath("cache.json", "/repo/tools", "/repo"), "/repo/tools/cache.json");
  assert.equal(exportPath("/abs/cache.json", "/repo", "/repo"), "/abs/cache.json");
  assert.equal(exportPath(undefined, "/elsewhere", "/repo"), "/repo/reports-cache.json");
});
