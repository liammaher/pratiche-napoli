// Reviewing reports: list the pending ones, accept (adding the maintainer's own
// tip, rejection reason or normalised extra document) or reject them, delete one
// on request, and export the accepted ones for `npm run reports:aggregate`.
// The export leaves out the person's free text and contact: the published
// figures only need the structured fields and the maintainer's words.

import type { Firestore } from "firebase-admin/firestore";

type Data = Record<string, unknown>;

export interface Review {
  tip?: string;
  rejection_reason?: string;
  extra_document?: string;
}

const MAX_TEXT = 300;

export async function pending(db: Firestore): Promise<(Data & { id: string })[]> {
  const snap = await db.collection("reports").where("status", "==", "pending").get();
  return snap.docs
    .map((d): Data & { id: string } => ({ id: d.id, ...d.data() }))
    .sort((a, b) => String(a.procedure).localeCompare(String(b.procedure)) || time(a) - time(b));
}

export async function show(db: Firestore, id: string): Promise<{ report: Data; contact?: string }> {
  const [report, contact] = await Promise.all([db.doc(`reports/${id}`).get(), db.doc(`contacts/${id}`).get()]);
  if (!report.exists) throw new Error(`no report ${id}`);
  return { report: report.data()!, contact: contact.data()?.contact_email };
}

export async function accept(db: Firestore, id: string, review: Review, now = new Date()): Promise<void> {
  for (const [field, text] of Object.entries(review)) {
    if (text !== undefined && (!text.trim() || text.length > MAX_TEXT)) {
      throw new Error(`${field} must be 1–${MAX_TEXT} characters`);
    }
  }
  await setStatus(db, id, "accepted", now, Object.fromEntries(Object.entries(review).filter(([, v]) => v !== undefined)));
}

export async function reject(db: Firestore, id: string, now = new Date()): Promise<void> {
  await setStatus(db, id, "rejected", now, {});
}

// For a request to delete someone's data: the report and its contact.
export async function remove(db: Firestore, id: string): Promise<void> {
  const ref = db.doc(`reports/${id}`);
  if (!(await ref.get()).exists) throw new Error(`no report ${id}`);
  await db.batch().delete(ref).delete(db.doc(`contacts/${id}`)).commit();
}

const EXPORTED = ["procedure", "done", "channel", "outcome", "days_to_answer", "desk_wait_minutes", "paid_eur", "documents"];

export async function exportAccepted(db: Firestore): Promise<Data[]> {
  const snap = await db.collection("reports").where("status", "==", "accepted").get();
  return snap.docs
    .map((d) => {
      const data = d.data();
      const out: Data = { id: d.id };
      for (const key of [...EXPORTED, "tip", "rejection_reason", "extra_document"]) {
        if (data[key] !== undefined) out[key] = data[key];
      }
      return out;
    })
    .sort((a, b) => String(a.procedure).localeCompare(String(b.procedure)) || String(a.done).localeCompare(String(b.done)));
}

// One pending report in a few lines, for the terminal.
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
