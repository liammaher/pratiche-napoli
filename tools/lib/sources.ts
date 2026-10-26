// Checks that the official pages and forms the procedures cite still answer,
// and, where a sha256 is recorded (PDF forms and regulations), that their
// content hasn't changed. Pages without one are only checked for an answer:
// their bytes change with every visit. The result is a Markdown report of
// what to re-verify, by procedure; empty when everything is as recorded.
//
// To ask the offices' servers as little as possible: documents with a sha256
// are checked every night, other pages one seventh a night (each on a fixed
// day of the week); requests carry the ETag and Last-Modified from the last
// check, so an unchanged file answers 304 without its body; a site that
// refused the checker is asked one address a night until it answers; and a
// saved state keeps every address's latest result, so a night's report
// covers the week.

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
  askedAt?: string; // when the request was made (ISO time); none for an address not asked
  validators?: Validators; // from an "ok" answer
  wayback?: string; // the Internet Archive's latest copy, for a page that failed
  waybackStatus?: string; // the HTTP status the archive saw for it
  waybackOn?: string; // when the archive gave that answer, when it was reused from an earlier night
  failingSince?: string; // for a page that failed, the first of the nights in a row it did
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
// and any page that didn't answer or was refused last time, so one that is
// back clears the report the next night rather than on its day. But a host
// that refuses the checker (see refusing) is asked only its probe, documents
// included, since asking every night is what keeps an address blocked; and
// any address of it never checked (newly cited, or a document whose sha256
// was recorded again), which would otherwise have no result at all.
export function tonight(targets: Target[], day: number, state: State = {}): Target[] {
  const probes = refusing(targets, state);
  return targets.filter((t) => {
    const seen = state[targetKey(t)];
    const probe = probes.get(hostOf(t.url));
    if (probe) return targetKey(t) === probe || !seen;
    return (
      t.sha256 ||
      slot(t.url) === day % DAYS ||
      !seen ||
      seen.status === "unreachable" ||
      seen.status === "blocked" ||
      day - dayNumber(seen.checkedOn) >= DAYS
    );
  });
}

// The hosts refusing the checker: those whose latest answers, among the
// cited addresses, were refusals (a 404 with one for the home page too,
// whether the archive saw the page gone or not: from here the two look the
// same). The latest by the time they were asked, not the night: a site that
// blocks an address after so many requests answers the first ones of a night
// and refuses the rest. It takes the last two answers (or the only one) to
// start, so one removed file asked last on a host whose home is 404 doesn't
// stop the rest of it being checked; on the nights after, the probe alone
// decides. For each host, the address refused last, by targetKey: its one
// probe a night, until it stops refusing.
export function refusing(targets: Target[], state: State): Map<string, string> {
  const byHost = new Map<string, { key: string; seen: Seen }[]>();
  for (const t of targets) {
    const seen = state[targetKey(t)];
    // An address not asked (held back with its host) says nothing.
    if (!seen || held(seen)) continue;
    byHost.set(hostOf(t.url), [...(byHost.get(hostOf(t.url)) ?? []), { key: targetKey(t), seen }]);
  }
  const when = (s: Seen) => s.askedAt ?? s.checkedOn;
  return new Map(
    [...byHost].flatMap(([host, answers]) => {
      const last = answers.sort((a, b) => (when(a.seen) < when(b.seen) ? 1 : when(a.seen) > when(b.seen) ? -1 : 0)).slice(0, 2);
      return last.every((a) => refused(a.seen)) ? [[host, last[0].key]] : [];
    }),
  );
}

const refused = (r: { detail?: string }) => !!r.detail?.startsWith(REFUSED);

// The other addresses of each host that refused its probe again tonight: not
// asked, so they count as refused with it. Their streak goes on, and after a
// week the report says that nothing on that site is being checked. One that
// was changed or not answering stays so, marked as not asked: a gone page or
// a changed form mustn't drop out of the report while its host refuses.
export function heldBack(targets: Target[], asked: Result[], state: State): Result[] {
  const probes = refusing(targets, state);
  const askedKeys = new Set(asked.map((r) => targetKey(r.target)));
  const refusedAgain = new Map(
    asked.flatMap((r) => (refused(r) && probes.get(hostOf(r.target.url)) === targetKey(r.target) ? [[hostOf(r.target.url), r.target.url]] : [])),
  );
  return targets.flatMap((t): Result[] => {
    const probe = refusedAgain.get(hostOf(t.url));
    if (!probe || askedKeys.has(targetKey(t))) return [];
    const seen = state[targetKey(t)];
    if (seen && (seen.status === "changed" || seen.status === "unreachable")) {
      return [
        {
          target: t,
          status: seen.status,
          detail: held(seen) ? seen.detail : `${HELD} ${seen.detail ?? seen.status}`,
          ...(seen.wayback && { wayback: seen.wayback, waybackStatus: seen.waybackStatus, waybackOn: seen.waybackOn ?? seen.checkedOn }),
        },
      ];
    }
    return [{ target: t, status: "blocked", detail: `${HELD} il sito rifiuta il controllo (prova: ${probe})` }];
  });
}

const HELD = "non chiesto stanotte:";
const REFUSED = "HTTP 404, anche per la home del sito";
const held = (r: { detail?: string }) => !!r.detail?.startsWith(HELD);

const hostOf = (url: string) => new URL(url).host;

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
  giveUpAfter?: number; // addresses in a row a site gave no answer for, after which it isn't asked tonight
  deadlineMs?: number; // after which nothing more is asked tonight
  userAgent?: string;
  sleep?: (ms: number) => Promise<void>; // for tests
  now?: () => number; // for tests
}

// Answers that may pass: too many requests, or a server briefly down.
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_WAIT_MS = 30_000;

// Fetches each target, gently: one request at a time per site, with a pause
// between them, and a few sites at once. Offices' servers can block an
// address that asks too much too fast. A network error, a 429 or a 5xx is
// tried once more after a pause (Retry-After when the server gives one)
// before it counts as unreachable. A site whose 404s come with a 404 for its
// home page too has those marked blocked, not unreachable. A site that
// accepts connections and then never answers would hold the run for hours
// (each document gets 4 timeouts, and a retry): after giveUpAfter addresses
// in a row with no answer at all, the rest of it isn't asked tonight, and
// after deadlineMs nothing more is. Those count as not answering, and are
// asked again the next night; the run ends either way, and saves what it saw.
export async function checkTargets(targets: Target[], fetchFn: typeof fetch, opts: CheckOptions = {}): Promise<Result[]> {
  const {
    concurrency = 4,
    pauseMs = 1_500,
    timeoutMs = 30_000,
    giveUpAfter = 2,
    deadlineMs = 60 * 60_000,
    userAgent,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    now = Date.now,
  } = opts;
  const results: Result[] = new Array(targets.length);
  const start = now();
  // Strictly increasing, so two requests never share a time.
  let last = 0;
  const stamp = () => new Date((last = Math.max(now(), last + 1))).toISOString();
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
      let silentInRow = 0;
      for (const [k, i] of indexes.entries()) {
        const skip =
          silentInRow >= giveUpAfter
            ? `${HELD} il sito non ha risposto agli ultimi ${giveUpAfter} indirizzi`
            : now() - start >= deadlineMs
              ? `${HELD} tempo del controllo finito`
              : undefined;
        if (skip) {
          results[i] = { target: targets[i], status: "unreachable", detail: skip };
          continue;
        }
        if (k) await sleep(pauseMs);
        const askedAt = stamp();
        let result = await attempt(targets[i]);
        if (result.retry) {
          await sleep(Math.max(result.waitMs ?? 5_000, pauseMs));
          result = await attempt(targets[i]);
        }
        results[i] = {
          target: result.target,
          status: result.status,
          askedAt,
          ...(result.detail && { detail: result.detail }),
          ...(result.validators && { validators: result.validators }),
        };
        silentInRow = result.status === "unreachable" && !answered(result) ? silentInRow + 1 : 0;
      }
      // Each host's home page, for its own 404s.
      const notFound = indexes.filter((i) => results[i].detail === "HTTP 404");
      for (const home of new Set(notFound.map((i) => origin(targets[i].url)).filter(Boolean))) {
        if (now() - start >= deadlineMs) break;
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
          results[i] = { ...results[i], status: "blocked", detail: REFUSED };
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

// Redirected to the site's home from a page that isn't it. "/index.php?id=5"
// or "/?p=12" is a page, not the home.
function sentHome(url: string, res: Response): boolean {
  if (!res.redirected || !res.url) return false;
  try {
    const home = (u: URL) => u.pathname.replace(/\/(index\.\w+)?$/, "") === "" && !u.search;
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
  askedAt?: string;
  validators?: Validators;
  wayback?: string;
  waybackStatus?: string;
  waybackOn?: string; // when the archive was asked, so its answer is reused for a week only
  failingSince?: string;
}
export type State = Record<string, Seen>;

// Tonight's results over the saved state, keeping only addresses still cited.
export function merge(state: State, results: Result[], checkedOn: string, targets: Target[]): State {
  const cited = new Set(targets.map(targetKey));
  // Results older than known() reads are dropped too: they would say nothing.
  const recent = (seen: Seen) => dayNumber(checkedOn) - dayNumber(seen.checkedOn) <= DAYS + 1;
  const out: State = Object.fromEntries(Object.entries(state).filter(([key, seen]) => cited.has(key) && recent(seen)));
  for (const r of results) {
    const before = out[targetKey(r.target)];
    out[targetKey(r.target)] = {
      status: r.status,
      checkedOn,
      ...(r.askedAt && { askedAt: r.askedAt }),
      ...(r.detail && { detail: r.detail }),
      ...(r.validators && { validators: r.validators }),
      // A new answer is dated tonight, a reused one keeps its date.
      ...(r.wayback && { wayback: r.wayback, ...(r.waybackStatus && { waybackStatus: r.waybackStatus }), waybackOn: r.waybackOn ?? checkedOn }),
      // A streak of failed nights, refused or not answering, goes on until a
      // night the page answers (or a result too old to count).
      ...(failing(r.status) && { failingSince: before && failing(before.status) ? (before.failingSince ?? before.checkedOn) : checkedOn }),
    };
  }
  return out;
}

const failing = (status: Result["status"]) => status === "unreachable" || status === "blocked";

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
        ...(seen.failingSince && { failingSince: seen.failingSince }),
      },
    ];
  });
}

// For pages that failed, what the Internet Archive last saw: a second
// opinion on whether a page is gone or only refusing the checker. It asks the
// Wayback Machine's CDX search for the latest capture, one page at a time
// and at most `limit`, reusing an answer saved (`saved`, by targetKey) in the
// last ARCHIVE_DAYS before `today` instead of asking again; a 429 is retried
// once after a pause. When an older answer can't be renewed (the lookup
// fails, or the night's limit is reached), the old one stands: a page gone
// yesterday is still gone, rather than blocked for a night.
export async function secondOpinion(
  results: Result[],
  fetchFn: typeof fetch,
  opts: {
    saved?: Map<string, { wayback: string; status?: string; on: string }>;
    today?: string; // without it, every saved answer is reused
    sleep?: (ms: number) => Promise<void>;
    pauseMs?: number;
    timeoutMs?: number;
    limit?: number;
  } = {},
): Promise<Result[]> {
  const { saved, today, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pauseMs = 1_000, timeoutMs = 20_000, limit = 30 } = opts;
  const lookup = (url: string) =>
    fetchFn(
      // Revisit records ("same as an earlier capture") carry no status: skip them.
      `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=-1&fl=timestamp,statuscode,original&filter=!mimetype:warc/revisit`,
      { signal: AbortSignal.timeout(timeoutMs) },
    ).catch(() => undefined);
  const out = [...results];
  let asked = 0;
  for (const [i, r] of out.entries()) {
    // An address not asked tonight has nothing to ask the archive about.
    if ((r.status !== "unreachable" && r.status !== "blocked") || held(r)) continue;
    const before = saved?.get(targetKey(r.target));
    // State saved before statuses were kept has the status only in the text.
    const reuse = () => before && { ...withArchive(r, before.wayback, before.status ?? before.wayback.match(/\(HTTP (\d{3})\)/)?.[1]), waybackOn: before.on };
    if (before && (!today || dayNumber(today) - dayNumber(before.on) < ARCHIVE_DAYS)) {
      out[i] = reuse()!;
      continue;
    }
    if (asked >= limit) {
      out[i] = reuse() ?? r;
      continue;
    }
    if (asked++) await sleep(pauseMs);
    let res = await lookup(r.target.url);
    if (res?.status === 429) {
      await sleep(Math.max(pauseMs, 10_000));
      res = await lookup(r.target.url);
      // Still too many: no more lookups tonight.
      if (res?.status === 429) asked = limit;
    }
    const rows = res?.ok ? ((await res.json().catch(() => undefined)) as string[][] | undefined) : undefined;
    if (!rows) {
      out[i] = reuse() ?? r;
      continue;
    }
    // A header row, then the latest capture, if there is one.
    const [timestamp, status, original] = rows[1] ?? [];
    out[i] = withArchive(
      r,
      timestamp
        ? `copia del ${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)} (${/^\d{3}$/.test(status) ? `HTTP ${status}` : "stato non registrato"}): https://web.archive.org/web/${timestamp}/${original}`
        : "nessuna copia nell'archivio",
      status,
    );
  }
  return out;
}

// How long the archive's answer is reused before asking again.
export const ARCHIVE_DAYS = 7;

// A result with the archive's answer. A site whose home is 404 too looked
// blocked; if the archive also last saw the page as gone, it is gone (a file
// host with no home page). That holds on the nights the answer is reused
// too, or the page would turn blocked again until the answer expires, and
// the issue close and reopen every week.
function withArchive(r: Result, wayback: string, status: string | undefined): Result {
  const gone = r.status === "blocked" && /^(404|410)$/.test(status ?? "");
  return {
    ...r,
    ...(gone && { status: "unreachable", detail: `${REFUSED}, e HTTP ${status} nell'archivio` }),
    wayback,
    ...(status && { waybackStatus: status }),
  };
}

// An HTTP status, a redirect or an error page is still an answer.
const answered = (r: Result) => /^(HTTP |rimanda |pagina d'errore)/.test(r.detail ?? "");

// When most sites gave no answer at all (no connection, no certificate the
// checker could verify), the problem is almost certainly on the checker's
// side (its network, its certificates), not in the sources: such a run says
// nothing either way, and mustn't report or close anything. Sites are
// counted, not addresses, so one big site refusing the checker (an HTTP
// answer, or blocked) doesn't silence the rest. The reason, or undefined
// when the run can be trusted.
export function inconclusive(results: Result[]): string | undefined {
  if (!results.length) return "nessun indirizzo da controllare";
  const silent = (r: Result) => r.status === "uncheckable" || (r.status === "unreachable" && !answered(r));
  const bySite = new Map<string, Result[]>();
  // An address not asked (the run's time was up) says nothing either way.
  for (const r of results.filter((r) => !held(r))) bySite.set(siteOf(r.target.url), [...(bySite.get(siteOf(r.target.url)) ?? []), r]);
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
// rest from the previous nights (results carry checkedOn only when older),
// and what a site refusing the checker wasn't asked.
function header(results: Result[], checkedOn: string): string {
  const notAsked = results.filter((r) => !r.checkedOn && held(r)).length;
  const tonightCount = results.filter((r) => !r.checkedOn).length - notAsked;
  const asked = tonightCount === results.length - notAsked
    ? `${tonightCount === results.length ? "tutti" : tonightCount} ${tonightCount === 1 ? "controllato" : "controllati"} stanotte`
    : `${tonightCount} ${tonightCount === 1 ? "controllato" : "controllati"} stanotte e gli altri nei giorni precedenti (i moduli ogni notte, le pagine una volta a settimana)`;
  return `Controllo delle fonti del ${checkedOn}: ${results.length} indirizzi, ${asked}${notAsked ? `; ${notAsked} non ${notAsked === 1 ? "chiesto" : "chiesti"} stanotte, a siti che non rispondono o rifiutano il controllo` : ""}.`;
}

// Empty unless something changed or stopped answering, or a site has refused
// the checker for a week or more: then what it serves goes unchecked, forms
// included, and a report that left it out would let the issue close as if
// all were well. Addresses that only couldn't be checked, or that a site
// refused for less than a week, are listed with them, but don't make a
// report alone.
export function report(results: Result[], checkedOn: string): string {
  const changed = results.filter((r) => r.status === "changed");
  const unreachable = results.filter((r) => r.status === "unreachable");
  const uncheckable = results.filter((r) => r.status === "uncheckable");
  const isBlocked = (r: Result) => r.status === "blocked";
  const forAWeek = (r: Result) => dayNumber(checkedOn) - dayNumber(r.failingSince ?? checkedOn) >= DAYS;
  const longBlocked = results.filter((r) => isBlocked(r) && forAWeek(r));
  const blocked = results.filter((r) => isBlocked(r) && !forAWeek(r));
  if (!changed.length && !unreachable.length && !longBlocked.length) return "";
  const item = (r: Result) =>
    `- ${r.target.url} (${r.detail}${r.failingSince && r.failingSince < (r.checkedOn ?? checkedOn) ? `, dal ${r.failingSince}` : ""}${r.checkedOn ? `, controllato il ${r.checkedOn}` : ""})\n${
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
    ...(longBlocked.length
      ? [
          `## Bloccati dal sito da almeno una settimana (${longBlocked.length})`,
          "",
          "Rispondono 404, come la home del sito, da almeno 7 giorni: o il sito rifiuta il controllo automatico, e allora i suoi indirizzi non vengono controllati (se un modulo cambia, non lo vediamo), o la pagina è stata tolta. Aprirli a mano da un browser, e confrontare i moduli con lo sha256 registrato finché il blocco dura.",
          "",
          ...items(longBlocked),
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
