// Checks that the official pages and forms the procedures cite still answer,
// and, where a sha256 is recorded (PDF forms and regulations), that their
// content hasn't changed. Pages without one are only checked for an answer:
// their bytes change with every visit. The result is a Markdown report of
// what to re-verify, by procedure; empty when everything is as recorded.
//
// To ask the offices' servers as little as possible: documents with a sha256
// are checked every night, other pages one seventh a night (each on a fixed
// day of the week); requests carry the ETag and Last-Modified from the last
// check, so an unchanged file answers 304 without its body; and a saved state
// keeps every address's latest result, so a night's report covers the week.

import { createHash } from "node:crypto";

export interface Target {
  url: string;
  sha256?: string;
  refs: string[]; // `napoli/comune/x: form "mod-1"`, every place that cites it
}

// What a server said about a file's version, sent back next time.
export interface Validators {
  etag?: string;
  lastModified?: string;
}

export interface Result {
  target: Target;
  checkedOn?: string; // YYYY-MM-DD, when it isn't tonight's check
  validators?: Validators; // from an "ok" answer
  wayback?: string; // the Internet Archive's latest copy, for a page that failed
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

// The key a target's state is saved under: its URL, and its sha256 when
// there is one, so a re-verified document starts afresh.
export const targetKey = (t: Target) => (t.sha256 ? `${t.url} ${t.sha256}` : t.url);

const DAYS = 7;

// Days since 1970-01-01 for a YYYY-MM-DD date: tonight's slot in the rotation.
export const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);

// A page's fixed day of the week, from its URL.
function slot(url: string): number {
  return createHash("sha256").update(url).digest().readUInt32BE(0) % DAYS;
}

// Tonight's share: every document with a sha256, and the pages whose day it is.
export function tonight(targets: Target[], day: number): Target[] {
  return targets.filter((t) => t.sha256 || slot(t.url) === day % DAYS);
}

export interface CheckOptions {
  validators?: Map<string, Validators>; // by targetKey, from the last check
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
    checkOne(target, fetchFn, timeoutMs, userAgent, opts.validators?.get(targetKey(target))).catch((e): Checked => {
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
        results[i] = {
          target: result.target,
          status: result.status,
          ...(result.detail && { detail: result.detail }),
          ...(result.validators && { validators: result.validators }),
        };
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

async function checkOne(
  target: Target,
  fetchFn: typeof fetch,
  timeoutMs: number,
  userAgent?: string,
  known?: Validators,
): Promise<Checked> {
  const headers: Record<string, string> = {
    ...(userAgent && { "user-agent": userAgent }),
    ...(known?.etag && { "if-none-match": known.etag }),
    ...(known?.lastModified && { "if-modified-since": known.lastModified }),
  };
  const res = await fetchFn(target.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: Object.keys(headers).length ? headers : undefined,
  });
  // Unchanged since the last check, which (validators are only kept from
  // "ok" answers) matched the sha256.
  if (res.status === 304) {
    await res.body?.cancel();
    return { target, status: "ok", validators: known };
  }
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
  const etag = res.headers.get("etag") ?? undefined;
  const lastModified = res.headers.get("last-modified") ?? undefined;
  const validators = etag || lastModified ? { ...(etag && { etag }), ...(lastModified && { lastModified }) } : undefined;
  if (!target.sha256) {
    await res.body?.cancel();
    return { target, status: "ok", ...(validators && { validators }) };
  }
  const actual = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
  return actual === target.sha256
    ? { target, status: "ok", ...(validators && { validators }) }
    : { target, status: "changed", detail: `sha256 ${actual.slice(0, 12)}…, registrato ${target.sha256.slice(0, 12)}…` };
}

// --- Saved state and the Internet Archive ---

// The latest result for each address (by targetKey), across nights.
export interface Seen {
  status: Result["status"];
  detail?: string;
  checkedOn: string;
  validators?: Validators;
  wayback?: string;
  waybackOn?: string; // when the archive was asked, so its answer is reused for a week only
}
export type State = Record<string, Seen>;

// Tonight's results over the saved state, keeping only addresses still cited.
export function merge(state: State, results: Result[], checkedOn: string, targets: Target[]): State {
  const cited = new Set(targets.map(targetKey));
  const out: State = Object.fromEntries(Object.entries(state).filter(([key]) => cited.has(key)));
  for (const r of results) {
    const before = state[targetKey(r.target)];
    out[targetKey(r.target)] = {
      status: r.status,
      checkedOn,
      ...(r.detail && { detail: r.detail }),
      ...(r.validators && { validators: r.validators }),
      ...(r.wayback && {
        wayback: r.wayback,
        waybackOn: before?.wayback === r.wayback && before.waybackOn ? before.waybackOn : checkedOn,
      }),
    };
  }
  return out;
}

// The latest known result for every cited address checked within maxAgeDays
// (a little over the rotation, so a missed night doesn't drop a problem).
export function known(state: State, targets: Target[], today: string, maxAgeDays = DAYS + 1): Result[] {
  return targets.flatMap((target) => {
    const seen = state[targetKey(target)];
    if (!seen || dayNumber(today) - dayNumber(seen.checkedOn) > maxAgeDays) return [];
    return [
      {
        target,
        status: seen.status,
        ...(seen.detail && { detail: seen.detail }),
        ...(seen.checkedOn !== today && { checkedOn: seen.checkedOn }),
        ...(seen.wayback && { wayback: seen.wayback }),
      },
    ];
  });
}

// For pages that failed, what the Internet Archive last saw: a second
// opinion on whether a page is gone or only refusing the checker. It asks the
// Wayback Machine's CDX search for the latest capture, one page at a time
// and at most `limit`, reusing an answer saved in the last week (`saved`, by
// targetKey) instead of asking again; a 429 is retried once after a pause,
// and a lookup that fails adds nothing.
export async function secondOpinion(
  results: Result[],
  fetchFn: typeof fetch,
  opts: {
    saved?: Map<string, string>;
    sleep?: (ms: number) => Promise<void>;
    pauseMs?: number;
    timeoutMs?: number;
    limit?: number;
  } = {},
): Promise<Result[]> {
  const { saved, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = 1_000, timeoutMs = 20_000, limit = 30 } = opts;
  const lookup = (url: string) =>
    fetchFn(
      `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=-1&fl=timestamp,statuscode,original`,
      { signal: AbortSignal.timeout(timeoutMs) },
    ).catch(() => undefined);
  const out = [...results];
  let asked = 0;
  for (const [i, r] of out.entries()) {
    if (r.status !== "unreachable" && r.status !== "blocked") continue;
    const before = saved?.get(targetKey(r.target));
    if (before) {
      out[i] = { ...r, wayback: before };
      continue;
    }
    if (asked >= limit) continue;
    if (asked++) await sleep(pauseMs);
    let res = await lookup(r.target.url);
    if (res?.status === 429) {
      await sleep(Math.max(pauseMs, 10_000));
      res = await lookup(r.target.url);
    }
    const rows = res?.ok ? ((await res.json().catch(() => undefined)) as string[][] | undefined) : undefined;
    if (!rows) continue;
    // A header row, then the latest capture, if there is one.
    const [timestamp, status, original] = rows[1] ?? [];
    out[i] = {
      ...r,
      wayback: timestamp
        ? `copia del ${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)} (HTTP ${status}): https://web.archive.org/web/${timestamp}/${original}`
        : "nessuna copia nell'archivio",
    };
  }
  return out;
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
    `- ${r.target.url} (${r.detail}${r.checkedOn ? `, controllato il ${r.checkedOn}` : ""})\n${
      r.wayback ? `  - Wayback Machine: ${r.wayback}\n` : ""
    }${r.target.refs.slice(0, MAX_REFS).map((ref) => `  - \`${ref}\``).join("\n")}${
      r.target.refs.length > MAX_REFS ? `\n  - e altre ${r.target.refs.length - MAX_REFS}` : ""
    }`;
  const items = (rs: Result[]) => [
    ...rs.slice(0, MAX_ITEMS).map(item),
    ...(rs.length > MAX_ITEMS ? [`- e altri ${rs.length - MAX_ITEMS} indirizzi: \`npm run check:sources\` li elenca tutti`] : []),
  ];
  const text = [
    `Controllo delle fonti del ${checkedOn}: ${results.length} indirizzi con un esito negli ultimi giorni (i moduli ogni notte, le pagine a rotazione nella settimana).`,
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
