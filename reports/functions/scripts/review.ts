// Reviewing reports: list the pending ones, accept (adding the maintainer's own
// tip, rejection reason or normalised extra document) or reject them, delete one
// on request, and export the accepted ones for `npm run reports:aggregate`.
// The export leaves out the person's free text and contact, and the report's
// id (their receipt): the published figures only need the structured fields,
// the maintainer's words and the report's random mark.

import path from "node:path";
import { FieldValue, type Firestore } from "firebase-admin/firestore";

type Data = Record<string, unknown>;

export interface Review {
  tip?: string;
  rejection_reason?: string;
  extra_document?: string;
}

const MAX_TEXT = 300;

// Reports with one status ("pending" by default), by procedure, oldest first.
export async function list(db: Firestore, status = "pending"): Promise<(Data & { id: string })[]> {
  const snap = await db.collection("reports").where("status", "==", status).get();
  return snap.docs
    .map((d): Data & { id: string } => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.procedure).localeCompare(String(b.procedure)) || time(a) - time(b));
}

// A report expires when its month leaves the window, often before its
// contact does: then only the contact is left to show.
export async function show(db: Firestore, id: string): Promise<{ report?: Data; contact?: string }> {
  const [report, contact] = await Promise.all([db.doc(`reports/${id}`).get(), db.doc(`contacts/${id}`).get()]);
  if (!report.exists && !contact.exists) throw new Error(`no report ${id}`);
  return { report: report.data(), contact: contact.data()?.contact_email };
}

// Accepting again changes the maintainer's fields: a text replaces the old
// one, an empty string removes it, and a field not given stays as it was.
export async function accept(db: Firestore, id: string, review: Review, now = new Date()): Promise<void> {
  const fields: Data = {};
  for (const [field, text] of Object.entries(review)) {
    if (text === undefined) continue;
    if (text === "") {
      fields[field] = FieldValue.delete();
      continue;
    }
    if (!text.trim() || text.length > MAX_TEXT) throw new Error(`${field} must be 1–${MAX_TEXT} characters, or empty to remove it`);
    fields[field] = text.trim();
  }
  await setStatus(db, id, "accepted", now, fields);
}

export async function reject(db: Firestore, id: string, now = new Date()): Promise<void> {
  await setStatus(db, id, "rejected", now, {});
}

// For a request from someone who left their email: their reports' ids.
export async function findByEmail(db: Firestore, email: string): Promise<string[]> {
  const snap = await db.collection("contacts").where("contact_email", "==", email.trim().toLowerCase()).get();
  return snap.docs.map((d) => d.id).sort();
}

// For a request to delete someone's data: the report and its contact,
// whichever of them is still there.
export async function remove(db: Firestore, id: string): Promise<void> {
  const report = db.doc(`reports/${id}`);
  const contact = db.doc(`contacts/${id}`);
  const [r, c] = await Promise.all([report.get(), contact.get()]);
  if (!r.exists && !c.exists) throw new Error(`no report ${id}`);
  await db.batch().delete(report).delete(contact).commit();
}

const EXPORTED = ["procedure", "done", "channel", "outcome", "days_to_answer", "desk_wait_minutes", "paid_eur", "documents"];

export async function exportAccepted(db: Firestore): Promise<Data[]> {
  const snap = await db.collection("reports").where("status", "==", "accepted").get();
  return snap.docs
    .map((d) => {
      const data = d.data();
      if (typeof data.mark !== "string") throw new Error(`report ${d.id} has no mark`);
      const out: Data = {};
      for (const key of ["mark", ...EXPORTED, "tip", "rejection_reason", "extra_document"]) {
        if (data[key] !== undefined) out[key] = data[key];
      }
      return out;
    })
    .sort((a, b) => String(a.procedure).localeCompare(String(b.procedure)) || String(a.done).localeCompare(String(b.done)));
}

// Where `export` writes: the path given, read from where the command was run
// (npm runs scripts in reports/functions and keeps that place in INIT_CWD),
// or reports-cache.json at the repo root.
export function exportPath(arg: string | undefined, from: string, root: string): string {
  return arg ? path.resolve(from, arg) : path.join(root, "reports-cache.json");
}

// One report in a few lines, for the terminal, with the maintainer's fields.
export function describe(r: Data & { id: string }): string {
  const docs = (r.documents as { name: string; asked: boolean }[] | undefined) ?? [];
  const feedback = (r.claim_feedback as { section: string; verdict: string; text?: string }[] | undefined) ?? [];
  const facts = [
    r.done,
    `${r.channel} (${r.office})`,
    r.outcome,
    r.days_to_answer !== undefined && `${r.days_to_answer} giorni`,
    r.desk_wait_minutes !== undefined && `${r.desk_wait_minutes} min allo sportello`,
    r.paid_eur !== undefined && `${r.paid_eur} €`,
    r.source === "agent" && "da un assistente",
    r.pii_redacted && "DATI PERSONALI RIMOSSI",
  ].filter(Boolean);
  const lines = [`  ${r.id}  ${facts.join(" · ")}`];
  if (docs.length) lines.push(`    documenti: ${docs.map((d) => `${d.name}: ${d.asked ? "sì" : "no"}`).join("; ")}`);
  if (r.extra_documents) lines.push(`    altri documenti: ${r.extra_documents}`);
  for (const f of feedback) lines.push(`    segnala ${f.section}: ${f.verdict}${f.text ? ` – ${f.text}` : ""}`);
  if (r.note) lines.push(`    nota: ${r.note}`);
  if (r.consent_contact) lines.push("    si può ricontattare (npm run reports -- show <id>)");
  for (const field of ["tip", "rejection_reason", "extra_document"]) {
    if (r[field]) lines.push(`    ${field}: ${r[field]}`);
  }
  return lines.join("\n");
}

async function setStatus(db: Firestore, id: string, status: string, now: Date, extra: Data): Promise<void> {
  const ref = db.doc(`reports/${id}`);
  await db.runTransaction(async (t) => {
    const doc = await t.get(ref);
    if (!doc.exists) throw new Error(`no report ${id}`);
    t.update(ref, { status, reviewed_at: now, ...extra });
  });
}

function time(r: Data): number {
  const at = r.received_at as { toMillis?: () => number } | undefined;
  return at?.toMillis?.() ?? 0;
}
