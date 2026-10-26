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
  status: "ok" | "changed" | "unreachable" | "uncheckable";
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
  concurrency?: number;
  timeoutMs?: number;
  userAgent?: string;
}

// Fetches each target (a few at a time, to be gentle with the offices'
// servers), retrying once before calling it unreachable.
export async function checkTargets(targets: Target[], fetchFn: typeof fetch, opts: CheckOptions = {}): Promise<Result[]> {
  const { concurrency = 4, timeoutMs = 30_000, userAgent } = opts;
  const results: Result[] = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const i = next++;
      results[i] = (await checkOne(targets[i], fetchFn, timeoutMs, userAgent).catch(() => undefined)) ??
        (await checkOne(targets[i], fetchFn, timeoutMs, userAgent).catch((e) => {
          const detail = failure(e as Error, timeoutMs);
          return { target: targets[i], status: CERTIFICATE.has(detail) ? ("uncheckable" as const) : ("unreachable" as const), detail };
        }));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return results;
}

// Node's fetch says only "fetch failed"; the cause says why (a DNS failure, a
// refused connection, a certificate the server doesn't send in full…).
function failure(e: Error, timeoutMs: number): string {
  if (e.name === "TimeoutError") return `nessuna risposta in ${timeoutMs / 1000} s`;
  const cause = e.cause as { code?: string; message?: string } | undefined;
  return cause?.code ?? cause?.message ?? e.message;
}

async function checkOne(target: Target, fetchFn: typeof fetch, timeoutMs: number, userAgent?: string): Promise<Result> {
  const res = await fetchFn(target.url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: userAgent ? { "user-agent": userAgent } : undefined,
  });
  if (!res.ok) {
    await res.body?.cancel();
    return { target, status: "unreachable", detail: `HTTP ${res.status}` };
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

// Empty unless something changed or stopped answering: addresses that only
// couldn't be checked are listed with them, but don't make a report alone.
export function report(results: Result[], checkedOn: string): string {
  const changed = results.filter((r) => r.status === "changed");
  const unreachable = results.filter((r) => r.status === "unreachable");
  const uncheckable = results.filter((r) => r.status === "uncheckable");
  if (!changed.length && !unreachable.length) return "";
  const item = (r: Result) => `- ${r.target.url} (${r.detail})\n${r.target.refs.map((ref) => `  - \`${ref}\``).join("\n")}`;
  return [
    `Controllo delle fonti del ${checkedOn}: ${results.length} indirizzi controllati.`,
    "",
    ...(changed.length
      ? [
          `## Moduli o documenti cambiati (${changed.length})`,
          "",
          "Il contenuto non corrisponde più allo sha256 registrato: rileggerli, aggiornare le procedure che li citano, lo sha256, `retrieved`, `verification` e `updated`.",
          "",
          ...changed.map(item),
          "",
        ]
      : []),
    ...(unreachable.length
      ? [
          `## Non raggiungibili (${unreachable.length})`,
          "",
          "Possono essere spostati, rimossi o solo bloccati per i controlli automatici: aprirli a mano prima di cambiare qualcosa.",
          "",
          ...unreachable.map(item),
          "",
        ]
      : []),
    ...(uncheckable.length
      ? [
          `## Non controllabili (${uncheckable.length})`,
          "",
          "Il certificato del sito non si verifica dal controllo automatico (di solito manca un certificato intermedio, che i browser recuperano da soli): controllarli a mano ogni tanto.",
          "",
          ...uncheckable.map(item),
          "",
        ]
      : []),
  ].join("\n");
}
