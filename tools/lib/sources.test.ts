import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { MAX_ITEMS, checkTargets, collectTargets, inconclusive, report, type Result } from "./sources.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("each address is checked once, with every procedure that cites it", () => {
  const targets = collectTargets([
    {
      id: "napoli/comune/a",
      sources: [
        { id: "mod", url: "https://x.it/mod.pdf", sha256: sha("v1") },
        { id: "page", url: "https://x.it/page" },
        { id: "law" },
      ],
      forms: [{ id: "mod", url: "https://x.it/mod.pdf", sha256: sha("v1") }],
    },
    { id: "napoli/comune/b", sources: [{ id: "p", url: "https://x.it/page" }] },
  ]);
  assert.deepEqual(targets, [
    { url: "https://x.it/mod.pdf", sha256: sha("v1"), refs: ['napoli/comune/a: fonte "mod"', 'napoli/comune/a: modulo "mod"'] },
    { url: "https://x.it/page", sha256: undefined, refs: ['napoli/comune/a: fonte "page"', 'napoli/comune/b: fonte "p"'] },
  ]);
});

// A stub fetch: a body per URL, a status, a thrown error, or a first-time failure.
function stub(pages: Record<string, string | number | Error | { failOnce: string }>) {
  const calls: string[] = [];
  const failed = new Set<string>();
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    assert.ok(init?.signal, "every request has a timeout");
    const page = pages[url];
    if (page instanceof Error) throw page;
    if (typeof page === "number") return new Response("no", { status: page });
    if (typeof page === "object") {
      if (!failed.has(url)) {
        failed.add(url);
        throw new TypeError("fetch failed");
      }
      return new Response(page.failOnce);
    }
    return new Response(page);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

test("unchanged forms and answering pages are fine; a changed form, a 404 and a timeout are reported", async () => {
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  const { fetchFn, calls } = stub({
    "https://x.it/same.pdf": "v1",
    "https://x.it/new.pdf": "v2",
    "https://x.it/page": "<html>",
    "https://x.it/gone": 404,
    "https://x.it/slow": timeout,
    "https://x.it/cert": Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }),
    "https://x.it/flaky.pdf": { failOnce: "v1" },
  });
  const target = (url: string, body?: string) => ({ url, sha256: body && sha(body), refs: [`napoli/comune/a: fonte "${url.slice(13)}"`] });
  const results = await checkTargets(
    [
      target("https://x.it/same.pdf", "v1"),
      target("https://x.it/new.pdf", "v1"),
      target("https://x.it/page"),
      target("https://x.it/gone"),
      target("https://x.it/slow"),
      target("https://x.it/flaky.pdf", "v1"),
      target("https://x.it/cert"),
    ],
    fetchFn,
    { concurrency: 2, timeoutMs: 1000, sleep: async () => {} },
  );
  assert.deepEqual(
    results.map((r) => [r.target.url.slice(13), r.status]),
    [
      ["same.pdf", "ok"],
      ["new.pdf", "changed"],
      ["page", "ok"],
      ["gone", "unreachable"],
      ["slow", "unreachable"],
      ["flaky.pdf", "ok"], // retried once
      ["cert", "uncheckable"],
    ],
  );
  assert.equal(calls.filter((u) => u.endsWith("flaky.pdf")).length, 2);
  assert.equal(calls.filter((u) => u.endsWith("slow")).length, 2);

  const text = report(results, "2026-10-26");
  assert.match(text, /Controllo delle fonti del 2026-10-26: 7 indirizzi controllati\./);
  assert.match(text, /## Non controllabili \(1\)[\s\S]*https:\/\/x\.it\/cert \(UNABLE_TO_VERIFY_LEAF_SIGNATURE\)/);
  assert.match(text, /## Moduli o documenti cambiati \(1\)[\s\S]*https:\/\/x\.it\/new\.pdf \(sha256 [0-9a-f]{12}…, registrato [0-9a-f]{12}…\)\n {2}- `napoli\/comune\/a: fonte "new\.pdf"`/);
  assert.match(text, /## Non raggiungibili \(2\)[\s\S]*https:\/\/x\.it\/gone \(HTTP 404\)[\s\S]*https:\/\/x\.it\/slow \(nessuna risposta in 1 s\)/);
  assert.doesNotMatch(text, /same\.pdf|flaky\.pdf|x\.it\/page /);
});

test("when everything answers as recorded the report is empty", async () => {
  const { fetchFn } = stub({ "https://x.it/a.pdf": "v1" });
  const results = await checkTargets([{ url: "https://x.it/a.pdf", sha256: sha("v1"), refs: ["p: fonte"] }], fetchFn);
  assert.equal(report(results, "2026-10-26"), "");
});

test("an address that can't be checked doesn't make a report on its own", async () => {
  const { fetchFn } = stub({
    "https://x.it/cert": Object.assign(new TypeError("fetch failed"), { cause: { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" } }),
  });
  const results = await checkTargets([{ url: "https://x.it/cert", refs: ["p: fonte"] }], fetchFn, { sleep: async () => {} });
  assert.equal(results[0].status, "uncheckable");
  assert.equal(report(results, "2026-10-26"), "");
});

test("a 429 or 5xx is tried again after Retry-After; a 404 isn't", async () => {
  const calls: string[] = [];
  const waits: number[] = [];
  const seen = new Set<string>();
  const fetchFn = (async (url: string) => {
    calls.push(url);
    const first = !seen.has(url);
    seen.add(url);
    if (url.endsWith("busy")) return first ? new Response("", { status: 429, headers: { "retry-after": "7" } }) : new Response("ok");
    if (url.endsWith("down")) return new Response("", { status: 503 });
    if (url.endsWith("long")) return first ? new Response("", { status: 503, headers: { "retry-after": "3600" } }) : new Response("ok");
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const targets = ["busy", "down", "long", "gone"].map((name) => ({ url: `https://x.it/${name}`, refs: ["p: fonte"] }));
  const results = await checkTargets(targets, fetchFn, { concurrency: 1, sleep: async (ms) => void waits.push(ms) });
  assert.deepEqual(
    results.map((r) => [r.target.url.slice(13), r.status, r.detail]),
    [
      ["busy", "ok", undefined],
      ["down", "unreachable", "HTTP 503"],
      ["long", "ok", undefined],
      ["gone", "unreachable", "HTTP 404"],
    ],
  );
  // 7 s as asked, the default pause, and at most 30 s however long it asks.
  assert.deepEqual(waits, [7000, 5000, 30000]);
  assert.equal(calls.filter((u) => u.endsWith("gone")).length, 1);
});

const result = (status: Result["status"], n: number, refs = 1): Result[] =>
  Array.from({ length: n }, (_, i) => ({
    target: { url: `https://www.comune.napoli.it/pagina-lunga-${status}-${i}`, refs: Array.from({ length: refs }, (_, j) => `napoli/comune/procedura-${j}: fonte "f${j}"`) },
    status,
    detail: status === "changed" ? "sha256 0123456789ab…, registrato ba9876543210…" : "HTTP 404",
  }));

test("a run that reached too few addresses is inconclusive and reports nothing", () => {
  assert.equal(inconclusive([]), "nessun indirizzo da controllare");
  assert.equal(inconclusive([...result("ok", 10), ...result("unreachable", 4), ...result("uncheckable", 2)]), undefined);
  assert.equal(inconclusive([...result("ok", 3), ...result("uncheckable", 4)]), "4 indirizzi su 7 non raggiunti o non controllabili");
  assert.equal(inconclusive([...result("ok", 3), ...result("unreachable", 2), ...result("uncheckable", 2)]), "4 indirizzi su 7 non raggiunti o non controllabili");
});

test("however many problems, the report fits in an issue and says how many are left out", () => {
  const text = report([...result("changed", 300, 12), ...result("unreachable", 300, 12), ...result("uncheckable", 300, 12)], "2026-10-26");
  assert.ok(text.length < 65_536, `${text.length} characters`);
  assert.match(text, /## Moduli o documenti cambiati \(300\)/);
  assert.match(text, new RegExp(`- e altri ${300 - MAX_ITEMS} indirizzi`));
  assert.match(text, /  - e altre 7\n/);
});

test("an over-long report is cut at a whole address", () => {
  const long = (status: Result["status"]) =>
    result(status, 30).map((r) => ({ ...r, target: { ...r.target, url: `${r.target.url}?${"q".repeat(1500)}` } }));
  const text = report([...long("changed"), ...long("unreachable")], "2026-10-26");
  assert.ok(text.length < 65_536, `${text.length} characters`);
  assert.match(text, /\n\n\(Report troncato: `npm run check:sources` lo dà completo\.\)\n$/);
  // The cut never leaves half an address.
  assert.match(text.split("\n\n(Report troncato")[0], /\n {2}- `napoli\/comune\/procedura-0: fonte "f0"`$/);
});
