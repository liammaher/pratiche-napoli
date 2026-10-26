import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checkTargets, collectTargets, report } from "./sources.ts";

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
    { concurrency: 2, timeoutMs: 1000 },
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
  const results = await checkTargets([{ url: "https://x.it/cert", refs: ["p: fonte"] }], fetchFn);
  assert.equal(results[0].status, "uncheckable");
  assert.equal(report(results, "2026-10-26"), "");
});
