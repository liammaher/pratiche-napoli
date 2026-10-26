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

// Certificates that fail only for the checker: an incomplete chain, which
// browsers complete. An expired one fails for everyone, so it isn't here.
const CERTIFICATE = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "SELF_SIGNED_CERT_IN_CHAIN"]);

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

// Tonight's share: every document with a sha256, the pages whose day it is,
// any page without a saved result from the last week (on the first run,
// after the saved state is lost, or for a newly cited page), so the report
// always covers every address, never just the pages a night happened to see,
// and any page that didn't answer last time, so one that is back clears the
// report the next night rather than on its day.
export function tonight(targets: Target[], day: number, state: State = {}): Target[] {
  return targets.filter((t) => {
    const seen = state[targetKey(t)];
    return t.sha256 || slot(t.url) === day % DAYS || !seen || seen.status === "unreachable" || day - dayNumber(seen.checkedOn) >= DAYS;
  });
}

// The ETag and Last-Modified to send tonight, by targetKey. On a document's
// own day of the week none are sent, so it is downloaded and hashed whole: a
// file replaced without a newer date would otherwise answer 304 for ever.
export function validatorsTonight(state: State, targets: Target[], day: number): Map<string, Validators> {
  const out = new Map<string, Validators>();
  for (const t of targets) {
    const seen = state[targetKey(t)];
    if (seen?.validators && !(t.sha256 && slot(t.url) === day % DAYS)) out.set(targetKey(t), seen.validators);
  }
  return out;
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
  // A document is downloaded whole, which on a slow server takes longer.
  const limit = (target: Target) => (target.sha256 ? timeoutMs * 4 : timeoutMs);
  const attempt = (target: Target) =>
    checkOne(target, fetchFn, limit(target), userAgent, opts.validators?.get(targetKey(target))).catch((e): Checked => {
      const detail = failure(e as Error, limit(target));
      return { target, status: CERTIFICATE.has(detail) ? "uncheckable" : "unreachable", detail, retry: !CERTIFICATE.has(detail) };
    });
  const sites = new Map<string, number[]>();
  targets.forEach((t, i) => sites.set(siteOf(t.url), [...(sites.get(siteOf(t.url)) ?? []), i]));
  const queue = [...sites];
  const worker = async () => {
    for (let site = queue.shift(); site; site = queue.shift()) {
      const [, indexes] = site;
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
      // Each host's home page, for its own 404s.
      const notFound = indexes.filter((i) => results[i].detail === "HTTP 404");
      for (const home of new Set(notFound.map((i) => origin(targets[i].url)).filter(Boolean))) {
        await sleep(pauseMs);
        const status = await fetchFn(`${home}/`, {
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
          headers: userAgent ? { "user-agent": userAgent } : undefined,
        }).then(
          async (res) => (await res.body?.cancel(), res.status),
          () => undefined,
        );
        if (status !== 404) continue;
        for (const i of notFound.filter((i) => origin(targets[i].url) === home)) {
          results[i] = { ...results[i], status: "blocked", detail: "HTTP 404, anche per la home del sito" };
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, sites.size) }, worker));
  return results;
}

// One site for the pause between requests: hosts of the same domain usually
// share a server, so www.comune.napoli.it and static-www.comune.napoli.it are
// one (comune.napoli.it), as are the hosts under agenziaentrate.gov.it. The
// domain is the last two labels, or three under a short or local second level
// (gov.it, napoli.it, campania.it).
export function siteOf(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  const labels = host.split(".");
  const second = labels.at(-2) ?? "";
  const n = labels.length >= 3 && (second.length <= 3 || ["napoli", "campania", "regione"].includes(second)) ? 3 : 2;
  return labels.slice(-n).join(".");
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
  // "ok" answers) matched the sha256. Only an answer to the version sent says
  // so: a 304 to a plain request says nothing about a document's content.
  if (res.status === 304) {
    await res.body?.cancel();
    if (known || !target.sha256) return { target, status: "ok", validators: known };
    return { target, status: "unreachable", detail: "HTTP 304 a una richiesta senza versione" };
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
  const html = /^text\/html|xhtml/i.test(res.headers.get("content-type") ?? "");
  // A page that was removed often sends people to the home page instead.
  if (sentHome(target.url, res)) {
    await res.body?.cancel();
    return { target, status: "unreachable", detail: `rimanda alla home: ${res.url}` };
  }
  if (!target.sha256) {
    // Or answers 200 with an error page: its title says so.
    const title = html ? errorTitle(await start(res)) : (await res.body?.cancel(), undefined);
    if (title) return { target, status: "unreachable", detail: `pagina d'errore: "${title}"` };
    return { target, status: "ok", ...(validators && { validators }) };
  }
  const actual = createHash("sha256").update(Buffer.from(await res.arrayBuffer())).digest("hex");
  if (actual === target.sha256) return { target, status: "ok", ...(validators && { validators }) };
  // A document whose address now leads to a web page has moved, not changed.
  if (res.redirected && html) return { target, status: "unreachable", detail: `rimanda a una pagina web: ${res.url}` };
  return {
    target,
    status: "changed",
    detail: `sha256 ${actual.slice(0, 12)}…, registrato ${target.sha256.slice(0, 12)}…${html ? "; ora è una pagina web, forse d'errore" : ""}`,
  };
}

// Redirected to the site's home from a page that isn't it.
function sentHome(url: string, res: Response): boolean {
  if (!res.redirected || !res.url) return false;
  try {
    const home = (u: URL) => u.pathname.replace(/\/(index\.\w+)?$/, "") === "";
    return home(new URL(res.url)) && !home(new URL(url));
  } catch {
    return false;
  }
}

// The first 64 KB of a page's text, enough for its <title>; the rest isn't fetched.
async function start(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < 65_536) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  await reader.cancel();
  return Buffer.concat(chunks).toString("utf8");
}

// The <title> of an error page ("Pagina non trovata", "404 Not Found"), or undefined.
function errorTitle(text: string): string | undefined {
  const title = text.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1].replace(/\s+/g, " ").trim();
  // "404" only at the start: a title can cite a law numbered 404.
  return title && /^(errore |error )?404\b|non (è stata )?trovat|not found|inesistente|non esiste/i.test(title) ? title : undefined;
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
  // Results older than known() reads are dropped too: they would say nothing.
  const recent = (seen: Seen) => dayNumber(checkedOn) - dayNumber(seen.checkedOn) <= DAYS + 1;
  const out: State = Object.fromEntries(Object.entries(state).filter(([key, seen]) => cited.has(key) && recent(seen)));
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
      // Revisit records ("same as an earlier capture") carry no status: skip them.
      `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=-1&fl=timestamp,statuscode,original&filter=!mimetype:warc/revisit`,
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
      // Still too many: no more lookups tonight.
      if (res?.status === 429) asked = limit;
    }
    const rows = res?.ok ? ((await res.json().catch(() => undefined)) as string[][] | undefined) : undefined;
    if (!rows) continue;
    // A header row, then the latest capture, if there is one.
    const [timestamp, status, original] = rows[1] ?? [];
    out[i] = {
      ...r,
      wayback: timestamp
        ? `copia del ${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)} (${/^\d{3}$/.test(status) ? `HTTP ${status}` : "stato non registrato"}): https://web.archive.org/web/${timestamp}/${original}`
        : "nessuna copia nell'archivio",
    };
  }
  return out;
}

// When most sites gave no answer at all (no connection, no certificate the
// checker could verify), the problem is almost certainly on the checker's
// side (its network, its certificates), not in the sources: such a run says
// nothing either way, and mustn't report or close anything. Sites are
// counted, not addresses, so one big site refusing the checker (an HTTP
// answer, or blocked) doesn't silence the rest. The reason, or undefined
// when the run can be trusted.
export function inconclusive(results: Result[]): string | undefined {
  if (!results.length) return "nessun indirizzo da controllare";
  const silent = (r: Result) => r.status === "uncheckable" || (r.status === "unreachable" && !/^HTTP /.test(r.detail ?? ""));
  const bySite = new Map<string, Result[]>();
  for (const r of results) bySite.set(siteOf(r.target.url), [...(bySite.get(siteOf(r.target.url)) ?? []), r]);
  const failed = [...bySite.values()].filter((rs) => rs.every(silent)).length;
  return failed > bySite.size / 2 ? `${failed} siti su ${bySite.size} senza risposta` : undefined;
}

// Sections list at most MAX_ITEMS addresses and MAX_REFS citations each, and
// the whole report is cut at MAX_CHARS, so an issue stays under GitHub's
// 65,536-character limit.
export const MAX_ITEMS = 25;
const MAX_REFS = 5;
const MAX_CHARS = 60_000;

// What the report covers: all checked tonight, or tonight's share and the
// rest from the previous nights (results carry checkedOn only when older).
function header(results: Result[], checkedOn: string): string {
  const tonightCount = results.filter((r) => !r.checkedOn).length;
  return tonightCount === results.length
    ? `Controllo delle fonti del ${checkedOn}: ${results.length} indirizzi, tutti controllati stanotte.`
    : `Controllo delle fonti del ${checkedOn}: ${results.length} indirizzi, ${tonightCount} ${tonightCount === 1 ? "controllato" : "controllati"} stanotte e gli altri nei giorni precedenti (i moduli ogni notte, le pagine una volta a settimana).`;
}

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
    header(results, checkedOn),
    "",
    ...(changed.length
      ? [
          `## Moduli o documenti cambiati (${changed.length})`,
          "",
          "Il contenuto non corrisponde più allo sha256 registrato: aprirli prima di tutto (se al posto del documento c'è una pagina d'errore o di accesso, il documento è stato spostato: cercarlo e aggiornarne l'indirizzo), poi rileggerli, aggiornare le procedure che li citano, lo sha256, `retrieved`, `verification` e `updated`.",
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
