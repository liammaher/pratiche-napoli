// Runs the handler against the Firestore emulator: npm run test:emulator.

import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { http } from "@google-cloud/functions-framework";
import { getTestServer } from "@google-cloud/functions-framework/testing";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { createHandler, MAX_BYTES, parseForm, rateLimitAddress, type Req, type Res } from "../src/handler";
import { procedureIndex } from "../src/procedures";

const PROJECT = "demo-pratiche-napoli";
const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
if (!EMULATOR) throw new Error("FIRESTORE_EMULATOR_HOST is not set: run npm run test:emulator");

const db = getFirestore(initializeApp({ projectId: PROJECT }));
const SITE = "https://example.org/pratiche";
const NOW = new Date("2026-10-15T10:30:00Z");
const handler = createHandler({
  db,
  siteUrl: SITE,
  salt: "test-salt",
  procedureIds: async () => new Set(["napoli/comune/tari-iscrizione"]),
  now: () => NOW,
});

const REPORT = {
  procedure: "napoli/comune/tari-iscrizione",
  source: "web",
  done: "2026-09",
  channel: "desk",
  office: "Sportello TARI di via Diaz",
  outcome: "completata",
  days_to_answer: 12,
  documents: [{ name: "Contratto di locazione", asked: true }],
};

// The same handler behind the functions framework that Cloud Run functions
// runs, so its body parsing (rawBody, form and text bodies) is covered too.
http("submitReport", (req, res) => handler(req, res));
const server = getTestServer("submitReport").listen(0, "127.0.0.1");
after(() => server.close());

async function viaFramework(body: string, type: string, ip = `203.0.113.${nextIp++}`) {
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}/`, {
    method: "POST",
    headers: { "Content-Type": type, "X-Forwarded-For": ip, Origin: "https://example.org" },
    body,
    redirect: "manual",
  });
}

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

let nextIp = 1;
// Each test sends from its own address unless it says otherwise, so the rate limit doesn't leak between tests.
async function send(
  body: string,
  { type = "application/json", ip = `203.0.113.${nextIp++}`, method = "POST", origin }: { type?: string; ip?: string; method?: string; origin?: string } = {},
): Promise<Reply> {
  const reply: Reply = { status: 200, headers: {}, body: undefined };
  const res: Res = {
    status(code) {
      reply.status = code;
      return res;
    },
    set(field, value) {
      reply.headers[field.toLowerCase()] = value;
      return res;
    },
    json(b) {
      reply.body = b;
    },
    send(b) {
      reply.body = b;
    },
    end() {},
  };
  const req: Req = {
    method,
    headers: { "content-type": type, "x-forwarded-for": `198.51.100.7, ${ip}`, ...(origin && { origin }) },
    rawBody: Buffer.from(body),
  };
  await handler(req, res);
  return reply;
}

const postJson = (report: unknown, opts: { ip?: string } = {}) => send(JSON.stringify(report), opts);
const postForm = (fields: Record<string, string>) =>
  send(new URLSearchParams(fields).toString(), { type: "application/x-www-form-urlencoded" });

async function docs(collection: string) {
  return (await db.collection(collection).get()).docs;
}

beforeEach(async () => {
  const res = await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  assert.ok(res.ok, `clearing the emulator: HTTP ${res.status}`);
});

test("a valid JSON report is stored pending review", async () => {
  const reply = await postJson(REPORT);
  assert.equal(reply.status, 201);
  const [doc, ...more] = await docs("reports");
  // The report's code, for asking later to see or delete it.
  assert.deepEqual(reply.body, { ok: true, id: doc.id });
  assert.equal(more.length, 0);
  const { received_at, expires_at, mark, ...stored } = doc.data();
  assert.deepEqual(stored, { ...REPORT, status: "pending", schema_version: 0, pii_redacted: false });
  // Random, and nothing like the id the sender got.
  assert.match(mark, /^[0-9a-f]{12}$/);
  assert.ok(received_at instanceof Timestamp);
  assert.equal(received_at.toMillis(), NOW.getTime());
  // Deleted once its month (2026-09) leaves the 12-month window.
  assert.equal(expires_at.toDate().toISOString(), "2027-09-01T00:00:00.000Z");
  assert.equal((await docs("contacts")).length, 0);
});

test("a form post is stored and redirected to the thank-you page", async () => {
  const reply = await postForm({
    procedure: REPORT.procedure,
    source: "web",
    done: "2026-09",
    channel: "desk",
    office: "Sportello TARI di via Diaz",
    outcome: "chiesto_altro",
    days_to_answer: "12",
    paid_eur: "16,50",
    desk_wait_minutes: "",
    "documents[0][name]": "Contratto di locazione",
    "documents[0][asked]": "si",
    "documents[1][name]": "Planimetria",
    "documents.2.name": "Visura catastale",
    "documents.2.asked": "no",
    "claim_feedback[0][section]": "deadline",
    "claim_feedback[0][verdict]": "superata",
    "claim_feedback[0][text]": "Ora i giorni sono 90",
    "claim_feedback[1][section]": "documents",
    website: "",
  });
  assert.equal(reply.status, 303);
  const [doc] = await docs("reports");
  assert.equal(reply.headers.location, `${SITE}/grazie/#${doc.id}`);
  const stored = doc.data();
  assert.equal(stored.status, "pending");
  assert.equal(stored.outcome, "chiesto_altro");
  assert.equal(stored.days_to_answer, 12);
  assert.equal(stored.paid_eur, 16.5);
  assert.equal("desk_wait_minutes" in stored, false);
  assert.equal("website" in stored, false);
  assert.deepEqual(stored.documents, [
    { name: "Contratto di locazione", asked: true },
    { name: "Visura catastale", asked: false },
  ]);
  assert.deepEqual(stored.claim_feedback, [{ section: "deadline", verdict: "superata", text: "Ora i giorni sono 90" }]);
});

test("a report the schema rejects is answered 400 and not stored", async () => {
  for (const bad of [
    { ...REPORT, done: "2026-09-14" },
    { ...REPORT, outcome: "boh" },
    { ...REPORT, days_to_answer: 1000 },
    { ...REPORT, extra: "field" },
    { ...REPORT, note: "x".repeat(1001) },
    (({ office, ...rest }) => rest)(REPORT),
  ]) {
    const reply = await postJson(bad);
    assert.equal(reply.status, 400, JSON.stringify(bad));
    assert.equal((reply.body as { error: string }).error, "invalid_report");
  }
  const form = await postForm({ procedure: REPORT.procedure, source: "web", done: "1999-12", days_to_answer: "12 giorni" });
  assert.equal(form.status, 400);
  assert.match(form.headers["content-type"], /text\/html/);
  for (const field of ["done", "days_to_answer", "channel", "office", "outcome"]) {
    assert.match(String(form.body), new RegExp(`<code>${field}</code>`), field);
  }
  assert.equal((await docs("reports")).length, 0);
});

test("a month in the future is rejected", async () => {
  const reply = await postJson({ ...REPORT, done: "2026-11" });
  assert.equal(reply.status, 400);
  assert.equal((await docs("reports")).length, 0);
});

test("a month that has left the 12-month window is rejected, not stored to be deleted at once", async () => {
  // Now is October 2026: the window starts at November 2025.
  assert.equal((await postJson({ ...REPORT, done: "2025-10" })).status, 400);
  assert.equal((await postJson({ ...REPORT, done: "2025-11" })).status, 201);
  assert.equal((await docs("reports")).length, 1);
});

test("a report about a procedure the site doesn't list is rejected", async () => {
  const reply = await postJson({ ...REPORT, procedure: "napoli/comune/non-esiste" });
  assert.equal(reply.status, 400);
  assert.equal((reply.body as { error: string }).error, "unknown_procedure");
  assert.equal((await docs("reports")).length, 0);
});

test("a filled honeypot is accepted and silently dropped", async () => {
  const json = await postJson({ ...REPORT, website: "https://spam.example" });
  assert.equal(json.status, 201);
  assert.match((json.body as { id: string }).id, /^[A-Za-z0-9]{20}$/);
  const form = await postForm({ ...Object.fromEntries(Object.entries(REPORT).map(([k, v]) => [k, String(v)])), website: "spam" });
  assert.equal(form.status, 303);
  assert.equal((await docs("reports")).length, 0);
  assert.equal((await docs("ratelimits")).length, 0);
});

test("the 11th report from one address in an hour is refused", async () => {
  const ip = "192.0.2.44";
  for (let i = 0; i < 10; i++) assert.equal((await postJson(REPORT, { ip })).status, 201, `report ${i + 1}`);
  const refused = await postJson(REPORT, { ip });
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers["retry-after"]) > 0);
  assert.equal((await postJson(REPORT, { ip: "192.0.2.45" })).status, 201);
  assert.equal((await docs("reports")).length, 11);

  // Rejected reports don't use up the hour.
  for (let i = 0; i < 12; i++) assert.equal((await postJson({ ...REPORT, outcome: "boh" }, { ip: "192.0.2.46" })).status, 400);
  assert.equal((await postJson(REPORT, { ip: "192.0.2.46" })).status, 201);

  // Only a hash and a count are kept, and they expire at the end of the hour.
  const limits = await docs("ratelimits");
  assert.equal(limits.length, 3);
  for (const doc of limits) {
    assert.match(doc.id, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(doc.data()).sort(), ["count", "expires_at"]);
    assert.equal(doc.get("expires_at").toMillis(), Date.parse("2026-10-15T11:00:00Z"));
    assert.doesNotMatch(JSON.stringify(doc.data()), /192\.0\.2/);
  }
});

test("IPv6 addresses in one /64 share a limit", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await postJson(REPORT, { ip: `2001:db8:1:2::${i + 1}` })).status, 201);
  assert.equal((await postJson(REPORT, { ip: "2001:db8:1:2:abcd:1:2:3" })).status, 429);
  assert.equal((await postJson(REPORT, { ip: "2001:db8:1:3::1" })).status, 201);
  assert.equal(rateLimitAddress("2001:0DB8:0001:0002:0000:0000:0000:0001"), "2001:db8:1:2::/64");
  assert.equal(rateLimitAddress("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(rateLimitAddress("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(rateLimitAddress("192.0.2.1"), "192.0.2.1");
});

test("personal data in text fields is replaced and the report flagged", async () => {
  const reply = await postJson({
    ...REPORT,
    note: "Il mio cf è RSS MRA 85T10 A562S, l'ho dovuto ripetere due volte (sul modulo avevo scritto RSSMRA85T10A562X)",
    documents: [{ name: "Bonifico su IT60 X054 2811 1010 0000 0123 456", asked: true }],
    claim_feedback: [{ section: "payment", verdict: "sbagliata", text: "pagato da RSSMRA85T10A562S" }],
    extra_documents: "una copia con il cf rssmra85t1oa562s", // lower case, o for 0
  });
  assert.equal(reply.status, 201);
  const [doc] = await docs("reports");
  assert.equal(doc.get("note"), "Il mio cf è [rimosso], l'ho dovuto ripetere due volte (sul modulo avevo scritto [rimosso])");
  assert.equal(doc.get("documents")[0].name, "Bonifico su [rimosso]");
  assert.equal(doc.get("claim_feedback")[0].text, "pagato da [rimosso]");
  assert.equal(doc.get("extra_documents"), "una copia con il cf [rimosso]");
  assert.equal(doc.get("procedure"), REPORT.procedure);
  assert.equal(doc.get("pii_redacted"), true);
});

test("a contact email is stored only in contacts, and only with consent", async () => {
  const email = "maria@example.org";
  const reply = await postJson({ ...REPORT, consent_contact: true, contact_email: "Maria@Example.org" });
  assert.equal(reply.status, 201);
  const [report] = await docs("reports");
  assert.equal(report.get("contact_email"), undefined);
  assert.doesNotMatch(JSON.stringify(report.data()), /maria/);
  const contact = await db.collection("contacts").doc(report.id).get();
  assert.equal(contact.get("contact_email"), email);
  assert.equal(contact.get("expires_at").toMillis(), Date.parse("2027-10-15T10:30:00Z"));

  for (const bad of [{ contact_email: email }, { consent_contact: false, contact_email: email }]) {
    assert.equal((await postJson({ ...REPORT, ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await docs("contacts")).length, 1);
});

test("bodies over 10 KB, other types and other methods are refused", async () => {
  assert.equal((await postJson({ ...REPORT, note: "x".repeat(MAX_BYTES) })).status, 413);
  assert.equal((await send("hello", { type: "application/xml" })).status, 415);
  assert.equal((await send("{nope", {})).status, 400);
  assert.equal((await send("", { method: "GET" })).status, 405);
  assert.equal((await docs("reports")).length, 0);
});

test("CORS answers the site's origin only", async () => {
  const preflight = await send("", { method: "OPTIONS", origin: "https://example.org" });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers["access-control-allow-origin"], "https://example.org");
  assert.equal(preflight.headers["access-control-allow-headers"], "Content-Type");
  const other = await send(JSON.stringify(REPORT), { origin: "https://evil.example" });
  assert.equal(other.headers["access-control-allow-origin"], undefined);
});

test("the procedure index is fetched once and its ids cached", async () => {
  let fetches = 0;
  const ids = procedureIndex("https://example.org/procedures.json", async () => {
    fetches++;
    return { procedures: [{ id: "napoli/comune/a" }, { id: "napoli/comune/b" }] };
  });
  const [a, b] = await Promise.all([ids(), ids()]);
  assert.deepEqual([...(await ids())], ["napoli/comune/a", "napoli/comune/b"]);
  assert.equal(a, b);
  assert.equal(fetches, 1);
});

test("a site outage falls back to the last list and retries after a few minutes", async () => {
  let clock = 0;
  let fetches = 0;
  let up = true;
  const ids = procedureIndex(
    "https://example.org/procedures.json",
    async () => {
      fetches++;
      if (!up) throw new Error("down");
      return { procedures: [{ id: "napoli/comune/a" }] };
    },
    () => clock,
  );
  await ids();
  up = false;
  clock = 61 * 60 * 1000;
  assert.deepEqual([...(await ids())], ["napoli/comune/a"]);
  clock += 60 * 1000;
  await ids();
  assert.equal(fetches, 2);
  clock += 5 * 60 * 1000;
  up = true;
  await ids();
  assert.equal(fetches, 3);
});

test("Italian numbers in forms are read as meant", () => {
  assert.deepEqual(parseForm("paid_eur=1.000&desk_wait_minutes=45&days_to_answer=12,5"), {
    paid_eur: 1000,
    desk_wait_minutes: 45,
    days_to_answer: 12.5,
  });
  assert.deepEqual(parseForm("paid_eur=1.250,50"), { paid_eur: 1250.5 });
  assert.deepEqual(parseForm("paid_eur=16.50"), { paid_eur: 16.5 });
  assert.deepEqual(parseForm("paid_eur=0x10"), { paid_eur: "0x10" });
});

test("through the functions framework, JSON, text/plain and form posts are stored", async () => {
  for (const type of ["application/json", "text/plain;charset=UTF-8"]) {
    const res = await viaFramework(JSON.stringify(REPORT), type);
    assert.equal(res.status, 201, type);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://example.org");
  }
  const { documents, days_to_answer, ...fields } = REPORT;
  const form = await viaFramework(
    new URLSearchParams({ ...fields, days_to_answer: String(days_to_answer), "documents[0][name]": documents[0].name, "documents[0][asked]": "si" }).toString(),
    "application/x-www-form-urlencoded",
  );
  assert.equal(form.status, 303);
  assert.match(form.headers.get("location")!, new RegExp(`^${SITE}/grazie/#[A-Za-z0-9]{20}$`));
  const stored = (await docs("reports")).map((d) => {
    const { received_at, expires_at, mark, ...rest } = d.data();
    return rest;
  });
  assert.equal(stored.length, 3);
  for (const report of stored) assert.deepEqual(report, { ...REPORT, status: "pending", schema_version: 0, pii_redacted: false });
});

test("through the functions framework, malformed text/plain JSON gets a 400 with CORS", async () => {
  const res = await viaFramework("{nope", "text/plain");
  assert.equal(res.status, 400);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://example.org");
  assert.equal(((await res.json()) as { error: string }).error, "bad_json");
});

test("form fields with odd indexes stay for the schema to reject", () => {
  assert.deepEqual(parseForm("documents[100][name]=x&documents[0][asked]=on"), {
    "documents[100][name]": "x",
    documents: [{ asked: true }],
  });
});

test("a form correction missing its section or verdict is kept, not refused", () => {
  assert.deepEqual(parseForm("claim_feedback[0][verdict]=superata&claim_feedback[0][text]=Ora+90+giorni"), {
    claim_feedback: [{ section: "pagina", verdict: "superata", text: "Ora 90 giorni" }],
  });
  assert.deepEqual(parseForm("claim_feedback[0][section]=scadenza&claim_feedback[0][text]=Ora+90+giorni"), {
    claim_feedback: [{ section: "scadenza", verdict: "sbagliata", text: "Ora 90 giorni" }],
  });
  // A section chosen and nothing else said is no correction.
  assert.deepEqual(parseForm("claim_feedback[0][section]=scadenza"), {});
});
