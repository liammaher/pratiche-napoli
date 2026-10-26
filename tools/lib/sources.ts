// Checks that the official pages and forms the procedures cite still answer,
// and, where a sha256 is recorded (PDF forms and regulations), that their
// content hasn't changed. Pages without one are only checked for an answer:
// their bytes change with every visit. The result is a Markdown report of
// what to re-verify, by procedure; empty when everything is as recorded.

import { createHash } from "node:crypto";

export interface Target {
  url: string;
  sha256?: string;
  refs: string[]; // `napoli/comune/x: form "mod-1"`, every place that cites it
}

export interface Result {
  target: Target;
  // uncheckable: the server's certificate can't be verified (usually a chain
  // it doesn't send in full, which browsers fill in), so nothing is known.
  // blocked: a 404 from a site that also answers 404 for its home page, which
  // means it is refusing the checker (some servers block an address after
  // too many requests and answer "not found"), not that the page is gone.
  status: "ok" | "changed" | "unreachable" | "uncheckable" | "blocked";
  detail?: string;
}

const CERTIFICATE = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "CERT_HAS_EXPIRED",
]);

interface Cited {
  id: string;
  sources?: { id: string; url?: string; sha256?: string }[];
  forms?: { id: string; url?: string; sha256?: string }[];
}

// One target per URL and fingerprint, however many procedures cite it.
export function collectTargets(procedures: Cited[]): Target[] {
  const targets = new Map<string, Target>();
  for (const p of procedures) {
    const cited = [
      ...(p.sources ?? []).map((s) => ({ ...s, what: `fonte "${s.id}"` })),
      ...(p.forms ?? []).map((f) => ({ ...f, what: `modulo "${f.id}"` })),
    ];
    for (const c of cited) {
      if (!c.url) continue;
      const key = `${c.url} ${c.sha256 ?? ""}`;
      const target = targets.get(key) ?? targets.set(key, { url: c.url, sha256: c.sha256, refs: [] }).get(key)!;
      const ref = `${p.id}: ${c.what}`;
      if (!target.refs.includes(ref)) target.refs.push(ref);
    }
  }
  return [...targets.values()].sort((a, b) => a.url.localeCompare(b.url));
}

export interface CheckOptions {
  concurrency?: number; // sites checked at the same time
  pauseMs?: number; // between two requests to the same site
  timeoutMs?: number;
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>; // for tests
}

// Answers that may pass: too many requests, or a server briefly down.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_WAIT_MS = 30_000;

// Fetches each target, gently: one request at a time per site, with a pause
// between them, and a few sites at once. Offices' servers can block an
// address that asks too much too fast. A network error, a 429 or a 5xx is
// tried once more after a pause (Retry-After when the server gives one)
// before it counts as unreachable. A site whose 404s come with a 404 for its
// home page too has those marked blocked, not unreachable.
export async function checkTargets(targets: Target[], fetchFn: typeof fetch, opts: CheckOptions = {}): Promise<Result[]> {
  const {
    concurrency = 4,
    pauseMs = 1_500,
    timeoutMs = 30_000,
    userAgent,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;
  const results: Result[] = new Array(targets.length);
  const attempt = (target: Target) =>
    checkOne(target, fetchFn, timeoutMs, userAgent).catch((e): Checked => {
      const detail = failure(e as Error, timeoutMs);
      return { target, status: CERTIFICATE.has(detail) ? "uncheckable" : "unreachable", detail, retry: !CERTIFICATE.has(detail) };
    });
  const sites = new Map<string, number[]>();
  targets.forEach((t, i) => sites.set(origin(t.url), [...(sites.get(origin(t.url)) ?? []), i]));
  const queue = [...sites];
  const worker = async () => {
    for (let site = queue.shift(); site; site = queue.shift()) {
      const [home, indexes] = site;
      for (const [k, i] of indexes.entries()) {
        if (k) await sleep(pauseMs);
        let result = await attempt(targets[i]);
        if (result.retry) {
          await sleep(Math.max(result.waitMs ?? 5_000, pauseMs));
          result = await attempt(targets[i]);
        }
        results[i] = { target: result.target, status: result.status, ...(result.detail && { detail: result.detail }) };
      }
      const notFound = indexes.filter((i) => results[i].detail === "HTTP 404");
      if (notFound.length && home) {
        await sleep(pauseMs);
        const status = await fetchFn(`${home}/`, {
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
          headers: userAgent ? { "user-agent": userAgent } : undefined,
        }).then(
          async (res) => (await res.body?.cancel(), res.status),
          () => undefined,
        );
        if (status === 404) {
          for (const i of notFound) results[i] = { ...results[i], status: "blocked", detail: "HTTP 404, anche per la home del sito" };
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, sites.size) }, worker));
  return results;
}

// "https://servizionline.comune.napoli.it", or "" for an address that isn't a URL.
function origin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

// A result, with whether (and after how long) to try again.
interface Checked extends Result {
  retry?: boolean;
  waitMs?: number;
}

// Node's fetch says only "fetch failed"; the cause says why (a DNS failure, a
// refused connection, a certificate the server doesn't send in full…).
function failure(e: Error, timeoutMs: number): string {
  if (e.name === "TimeoutError") return `nessuna risposta in ${timeoutMs / 1000} s`;
  const cause = e.cause as { code?: string; message?: string } | undefined;
  return cause?.code ?? cause?.message ?? e.message;
}

async function checkOne(target: Target, fetchFn: typeof fetch, timeoutMs: number, userAgent?: string): Promise<Checked> {
  const res = await fetchFn(target.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: userAgent ? { "user-agent": userAgent } : undefined,
  });
  if (!res.ok) {
    await res.body?.cancel();
    const after = Number(res.headers.get("retry-after"));
    return {
      target,
      status: "unreachable",
      detail: `HTTP ${res.status}`,
      retry: RETRY_STATUS.has(res.status),
      ...(after > 0 && { waitMs: Math.min(after * 1000, MAX_WAIT_MS) }),
    };
  }
  if (!target.sha256) {
    await res.body?.cancel();
    return { target, status: "ok" };
  }
  const actual = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
  return actual === target.sha256
    ? { target, status: "ok" }
    : { target, status: "changed", detail: `sha256 ${actual.slice(0, 12)}…, registrato ${target.sha256.slice(0, 12)}…` };
}

// When most addresses couldn't be reached or checked, the problem is almost
// certainly on the checker's side (its network, its certificates), not in
// the sources: such a run says nothing either way, and mustn't report or
// close anything. The reason, or undefined when the run can be trusted.
export function inconclusive(results: Result[]): string | undefined {
  if (!results.length) return "nessun indirizzo da controllare";
  const failed = results.filter((r) => r.status !== "ok" && r.status !== "changed").length;
  return failed > results.length / 2 ? `${failed} indirizzi su ${results.length} non raggiunti o non controllabili` : undefined;
}

// Sections list at most MAX_ITEMS addresses and MAX_REFS citations each, and
// the whole report is cut at MAX_CHARS, so an issue stays under GitHub's
// 65,536-character limit.
export const MAX_ITEMS = 25;
const MAX_REFS = 5;
const MAX_CHARS = 60_000;

// Empty unless something changed or stopped answering: addresses that only
// couldn't be checked, or that a site refused, are listed with them, but
// don't make a report alone.
export function report(results: Result[], checkedOn: string): string {
  const changed = results.filter((r) => r.status === "changed");
  const unreachable = results.filter((r) => r.status === "unreachable");
  const uncheckable = results.filter((r) => r.status === "uncheckable");
  const blocked = results.filter((r) => r.status === "blocked");
  if (!changed.length && !unreachable.length) return "";
  const item = (r: Result) =>
    `- ${r.target.url} (${r.detail})\n${r.target.refs.slice(0, MAX_REFS).map((ref) => `  - \`${ref}\``).join("\n")}${
      r.target.refs.length > MAX_REFS ? `\n  - e altre ${r.target.refs.length - MAX_REFS}` : ""
    }`;
  const items = (rs: Result[]) => [
    ...rs.slice(0, MAX_ITEMS).map(item),
    ...(rs.length > MAX_ITEMS ? [`- e altri ${rs.length - MAX_ITEMS} indirizzi: \`npm run check:sources\` li elenca tutti`] : []),
  ];
  const text = [
    `Controllo delle fonti del ${checkedOn}: ${results.length} indirizzi controllati.`,
    "",
    ...(changed.length
      ? [
          `## Moduli o documenti cambiati (${changed.length})`,
          "",
          "Il contenuto non corrisponde più allo sha256 registrato: rileggerli, aggiornare le procedure che li citano, lo sha256, `retrieved`, `verification` e `updated`.",
          "",
          ...items(changed),
          "",
        ]
      : []),
    ...(unreachable.length
      ? [
          `## Non raggiungibili (${unreachable.length})`,
          "",
          "Possono essere spostati, rimossi o solo bloccati per i controlli automatici: aprirli a mano prima di cambiare qualcosa.",
          "",
          ...items(unreachable),
          "",
        ]
      : []),
    ...(uncheckable.length
      ? [
          `## Non controllabili (${uncheckable.length})`,
          "",
          "Il certificato del sito non si verifica dal controllo automatico (di solito manca un certificato intermedio, che i browser recuperano da soli): controllarli a mano ogni tanto.",
          "",
          ...items(uncheckable),
          "",
        ]
      : []),
    ...(blocked.length
      ? [
          `## Bloccati dal sito (${blocked.length})`,
          "",
          "Il sito risponde 404 anche alla sua home: di solito blocca il controllo automatico (per esempio dopo troppe richieste), non ha tolto le pagine. Aprirli a mano da un browser.",
          "",
          ...items(blocked),
          "",
        ]
      : []),
  ].join("\n");
  return text.length <= MAX_CHARS ? text : `${text.slice(0, text.lastIndexOf("\n- ", MAX_CHARS))}\n\n(Report troncato: \`npm run check:sources\` lo dà completo.)\n`;
}
