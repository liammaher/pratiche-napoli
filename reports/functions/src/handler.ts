// Receives a report of how a procedure went. Reports stay private: each is
// stored pending review, with personal data cut out of its text and the contact
// email kept apart. Of the sender only a salted hash of the IP is kept, for an
// hour, to limit how many reports one address can send.

import { createHash, randomBytes } from "node:crypto";
import { isIPv6 } from "node:net";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Timestamp, type Firestore } from "firebase-admin/firestore";
import { matchPersonalData } from "./shared/personal";
import schema from "./shared/report.schema.json";

export const MAX_BYTES = 10 * 1024;
export const REPORTS_PER_HOUR = 10;
export const REMOVED = "[rimosso]";
const HOUR_MS = 60 * 60 * 1000;
// Bots fill every field; people never see this one.
const HONEYPOT = "website";

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const checkReport = ajv.compile(schema);

// The parts of an Express request and response the handler uses, so tests can
// pass plain objects.
export interface Req {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: Buffer;
  ip?: string;
}

export interface Res {
  status(code: number): Res;
  set(field: string, value: string): Res;
  json(body: unknown): void;
  send(body: string): void;
  end(): void;
}

export type Handler = (req: Req, res: Res) => Promise<void>;

export interface Config {
  db: Firestore;
  siteUrl: string; // without a trailing slash
  salt: string;
  procedureIds: () => Promise<Set<string>>;
  now?: () => Date;
  // In the emulator, also answer pages served from localhost.
  devOrigins?: boolean;
}

export function createHandler(config: Config): Handler {
  const { db, siteUrl, salt, procedureIds, now = () => new Date() } = config;
  const siteOrigin = new URL(siteUrl).origin;
  const allowed = (origin: string) =>
    origin === siteOrigin || (!!config.devOrigins && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));

  return async (req, res) => {
    const origin = header(req, "origin");
    if (origin && allowed(origin)) res.set("Access-Control-Allow-Origin", origin).set("Vary", "Origin");
    if (req.method === "OPTIONS") {
      res
        .set("Access-Control-Allow-Methods", "POST")
        .set("Access-Control-Allow-Headers", "Content-Type")
        .set("Access-Control-Max-Age", "3600")
        .status(204)
        .end();
      return;
    }

    // A form posted without JavaScript gets pages back; fetch() gets JSON.
    const type = (header(req, "content-type") ?? "").split(";")[0].trim().toLowerCase();
    const form = type === "application/x-www-form-urlencoded";
    const fail = (status: number, error: string, message: string, details?: string[], fields?: string[]) => {
      if (form) res.status(status).set("Content-Type", "text/html; charset=utf-8").send(errorPage(message, siteUrl, fields));
      else res.status(status).json({ error, message, ...(details && { details }) });
    };
    // The report's code goes back, for asking later to see or delete it. On
    // the redirect it rides in the fragment, which browsers never send on.
    const accepted = (id: string) => {
      if (form) res.status(303).set("Location", `${siteUrl}/grazie/#${id}`).end();
      else res.status(201).json({ ok: true, id });
    };

    if (req.method !== "POST") {
      res.set("Allow", "POST, OPTIONS");
      return fail(405, "method_not_allowed", "Si accettano solo invii (POST).");
    }
    // The functions framework answers malformed application/json itself, with
    // an HTML 400 and no CORS headers. It never fails on text/plain, so browsers
    // should send the JSON as text/plain: then every error comes from here, and
    // no preflight is needed either.
    if (!form && type !== "application/json" && type !== "text/plain") {
      return fail(415, "unsupported_type", "Invia il resoconto come JSON o come modulo.");
    }
    const raw = req.rawBody ?? Buffer.alloc(0);
    if (raw.length > MAX_BYTES) return fail(413, "too_large", "Il resoconto è troppo lungo.");

    let data: unknown;
    try {
      data = form ? parseForm(raw.toString("utf8")) : JSON.parse(raw.toString("utf8"));
    } catch {
      return fail(400, "bad_json", "Il resoconto non è JSON valido.");
    }
    if (!isObject(data)) return fail(400, "bad_json", "Il resoconto deve essere un oggetto JSON.");

    // Answer as if it worked, so the bot learns nothing.
    if (filled(data[HONEYPOT])) return accepted(db.collection("reports").doc().id);
    delete data[HONEYPOT];

    try {
      const at = now();
      if (!checkReport(data)) {
        const errors = checkReport.errors ?? [];
        const details = errors.map((e) => `${e.instancePath || "/"} ${e.message}`);
        // The top-level field each error is about, for the form's error page.
        const fields = [
          ...new Set(errors.map((e) => e.instancePath.split("/")[1] || e.params.missingProperty || e.params.additionalProperty)),
        ].filter((f): f is string => typeof f === "string");
        return fail(400, "invalid_report", "Alcuni campi del resoconto non sono validi.", details, fields);
      }
      const report = data as Record<string, unknown> & { procedure: string; done: string; contact_email?: string };
      if (report.done > monthInRome(at)) {
        return fail(400, "invalid_report", "Il mese indicato è nel futuro.", ["/done is in the future"], ["done"]);
      }
      // An older report would be deleted at once, unread: it has left the window.
      if (leavesWindow(report.done) <= at) {
        return fail(400, "invalid_report", "Raccogliamo i racconti degli ultimi 12 mesi.", ["/done is over 12 months ago"], ["done"]);
      }

      let ids: Set<string>;
      try {
        ids = await procedureIds();
      } catch (err) {
        console.error("can't load the procedure index", err);
        return fail(503, "unavailable", "Non riusciamo a ricevere resoconti in questo momento: riprova più tardi.");
      }
      if (!ids.has(report.procedure)) return fail(400, "unknown_procedure", "Questa pratica non è nella libreria.");

      // Counted only for reports that would be stored, so fixing a rejected one doesn't use up the hour.
      if (!(await underLimit(db, salt, clientIp(req), at))) {
        res.set("Retry-After", String(Math.ceil((HOUR_MS - (at.getTime() % HOUR_MS)) / 1000)));
        return fail(429, "rate_limited", "Hai inviato troppi resoconti: riprova tra un'ora.");
      }

      const { contact_email, ...rest } = report;
      const { value, redacted } = redact(rest);
      const received_at = Timestamp.fromDate(at);
      const ref = db.collection("reports").doc();
      const batch = db.batch();
      batch.set(ref, {
        ...(value as object),
        status: "pending",
        received_at,
        expires_at: Timestamp.fromDate(leavesWindow(report.done)),
        schema_version: 0,
        pii_redacted: redacted,
        // What stands for the report in the published figures: random, so the
        // id the sender gets as a receipt can't find it there.
        mark: randomBytes(6).toString("hex"),
      });
      if (contact_email) {
        const expires = new Date(at);
        expires.setUTCFullYear(expires.getUTCFullYear() + 1);
        // Lower case, so a request to find it matches however it was typed.
        batch.set(db.collection("contacts").doc(ref.id), {
          contact_email: contact_email.trim().toLowerCase(),
          received_at,
          expires_at: Timestamp.fromDate(expires),
        });
      }
      await batch.commit();
      return accepted(ref.id);
    } catch (err) {
      console.error("can't store a report", err);
      return fail(500, "internal", "Qualcosa è andato storto: riprova più tardi.");
    }
  };
}

// Counts reports per address in hourly windows. The key hashes the hour too, so
// one address's windows can't be linked to each other.
async function underLimit(db: Firestore, salt: string, ip: string, at: Date): Promise<boolean> {
  const hour = Math.floor(at.getTime() / HOUR_MS);
  const key = createHash("sha256").update(`${salt}\n${hour}\n${rateLimitAddress(ip)}`).digest("hex");
  const ref = db.collection("ratelimits").doc(key);
  return db.runTransaction(async (tx) => {
    const count = ((await tx.get(ref)).get("count") as number | undefined) ?? 0;
    if (count >= REPORTS_PER_HOUR) return false;
    tx.set(ref, { count: count + 1, expires_at: Timestamp.fromMillis((hour + 1) * HOUR_MS) });
    return true;
  });
}

// Google's front end appends the address it saw to X-Forwarded-For, after any
// the client sent, so the last entry is the one that can't be forged.
function clientIp(req: Req): string {
  const last = header(req, "x-forwarded-for")?.split(",").at(-1)?.trim();
  return last || req.ip || "unknown";
}

// An IPv6 connection usually gets a whole /64 and can pick any address in it,
// so those addresses count as one. IPv4 written as IPv6 counts as IPv4.
export function rateLimitAddress(ip: string): string {
  const v4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)?.[1];
  if (v4 || !isIPv6(ip)) return v4 ?? ip;
  const groups = (part: string) => (part ? part.split(":").flatMap((g) => (g.includes(".") ? ["0", "0"] : [g])) : []);
  const [head, tail] = ip.split("%")[0].split("::");
  const left = groups(head);
  const right = groups(tail ?? "");
  const full = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
  return `${full.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}

// Cuts personal data out of every string in the report, mistyped codes too: a
// codice fiscale with one wrong letter still identifies its owner.
// Fields the schema already limits to ids, months and choices: never personal,
// and left whole so the report still names its procedure.
const STRUCTURED = new Set(["procedure", "source", "done", "channel", "outcome"]);

export function redact(value: unknown): { value: unknown; redacted: boolean } {
  let redacted = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      let out = "";
      let at = 0;
      for (const m of matchPersonalData(v, { checkDigits: false }).sort((a, b) => a.start - b.start)) {
        if (m.start >= at) out += v.slice(at, m.start) + REMOVED;
        at = Math.max(at, m.end);
      }
      if (!at) return v;
      redacted = true;
      return out + v.slice(at);
    }
    if (Array.isArray(v)) return v.map(walk);
    if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  if (!isObject(value)) return { value: walk(value), redacted };
  const out = Object.fromEntries(Object.entries(value).map(([k, x]) => [k, STRUCTURED.has(k) ? x : walk(x)]));
  return { value: out, redacted };
}

const NUMBERS = new Set(["days_to_answer", "desk_wait_minutes", "paid_eur"]);
const BOOLEANS = new Set(["consent_contact", "asked"]);
// documents[0][name] or documents.0.name; indexes stay small so a post can't build a huge list.
const LIST_ITEM = /^(documents|claim_feedback)(?:\[(\d{1,2})\]\[([a-z_]+)\]|\.(\d{1,2})\.([a-z_]+))$/;

// Turns a form post into a report. Empty fields are left out, numbers and
// yes/no answers are converted, and a listed document nobody answered about, or
// feedback without a verdict, is dropped. Anything else goes to the schema as is.
export function parseForm(body: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const lists = new Map<string, Map<number, Record<string, unknown>>>();
  for (const [key, raw] of new URLSearchParams(body)) {
    const value = raw.trim();
    if (!value) continue;
    const item = LIST_ITEM.exec(key);
    if (item) {
      const [list, index, field] = item[2] ? [item[1], item[2], item[3]] : [item[1], item[4], item[5]];
      const items = lists.get(list) ?? lists.set(list, new Map()).get(list)!;
      const entry = items.get(Number(index)) ?? items.set(Number(index), {}).get(Number(index))!;
      entry[field] = convert(field, value);
    } else {
      out[key] = convert(key, value);
    }
  }
  for (const [list, items] of lists) {
    const answered = [...items.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, entry]) => entry)
      .filter((entry) => (list === "documents" ? "asked" in entry : "verdict" in entry || "text" in entry))
      // A form can't require these together without JavaScript, so a
      // correction isn't lost for a missing choice: no section means the page
      // as a whole, and text with no verdict says what was found instead.
      .map((entry) => (list === "claim_feedback" ? { section: "pagina", verdict: "sbagliata", ...entry } : entry));
    if (answered.length) out[list] = answered;
  }
  return out;
}

function convert(field: string, value: string): unknown {
  if (NUMBERS.has(field)) {
    // 1.000 or 1.000,50 is Italian for a thousand; otherwise a comma or a dot is the decimal point.
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(value)) return Number(value.replace(/\./g, "").replace(",", "."));
    if (/^\d+([.,]\d+)?$/.test(value)) return Number(value.replace(",", "."));
    return value;
  }
  if (BOOLEANS.has(field)) {
    if (/^(true|on|1|s[iì]|yes)$/i.test(value)) return true;
    if (/^(false|off|0|no)$/i.test(value)) return false;
  }
  return value;
}

// Reports are kept while the published figures can use them: until their
// month leaves the 12-month window (a "2025-11" report on 1 November 2026).
// Firestore's TTL deletes them after that, pending and rejected ones too.
export function leavesWindow(done: string): Date {
  const [y, m] = done.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + 12, 1));
}

function monthInRome(at: Date): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit" }).format(at);
}

function errorPage(message: string, siteUrl: string, fields: string[] = []): string {
  const list = fields.length ? `\n<p>Controlla: ${fields.map((f) => `<code>${escapeHtml(f)}</code>`).join(", ")}.</p>` : "";
  return `<!doctype html>
<html lang="it">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Resoconto non inviato</title>
<p>${escapeHtml(message)}</p>${list}
<p><a href="${escapeHtml(siteUrl)}/">Torna al sito</a></p>
</html>
`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function header(req: Req, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v.join(",") : v;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function filled(v: unknown): boolean {
  return typeof v === "string" ? v.trim() !== "" : v !== undefined && v !== null && v !== false;
}
