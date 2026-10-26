import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MAX_ITEMS,
  checkTargets,
  collectTargets,
  dayNumber,
  inconclusive,
  known,
  merge,
  report,
  secondOpinion,
  targetKey,
  tonight,
  type Result,
  type State,
  type Validators,
} from "./sources.ts";

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
  assert.match(text, /Controllo delle fonti del 2026-10-26: 7 indirizzi con un esito negli ultimi giorni/);
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
    if (url === "https://x.it/") return new Response("home"); // the site's home answers: a real 404
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const targets = ["busy", "down", "long", "gone"].map((name) => ({ url: `https://x.it/${name}`, refs: ["p: fonte"] }));
  const results = await checkTargets(targets, fetchFn, { concurrency: 1, pauseMs: 0, sleep: async (ms) => void waits.push(ms) });
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
  assert.deepEqual(waits.filter(Boolean), [7000, 5000, 30000]);
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

test("one request at a time per site, with a pause between them; sites in parallel", async () => {
  const busy = new Map<string, number>();
  let mostAtOnce = 0;
  const perSite = new Map<string, number>();
  const fetchFn = (async (url: string) => {
    const host = new URL(url).host;
    busy.set(host, (busy.get(host) ?? 0) + 1);
    perSite.set(host, Math.max(perSite.get(host) ?? 0, busy.get(host)!));
    mostAtOnce = Math.max(mostAtOnce, [...busy.values()].reduce((a, b) => a + b, 0));
    await new Promise((r) => setTimeout(r, 5));
    busy.set(host, busy.get(host)! - 1);
    return new Response("ok");
  }) as unknown as typeof fetch;
  const pauses: number[] = [];
  const targets = ["a.it/1", "a.it/2", "a.it/3", "b.it/1", "b.it/2", "c.it/1"].map((p) => ({ url: `https://${p}`, refs: ["p: fonte"] }));
  const results = await checkTargets(targets, fetchFn, {
    concurrency: 3,
    pauseMs: 1500,
    sleep: async (ms) => void pauses.push(ms),
  });
  assert.ok(results.every((r) => r.status === "ok"));
  assert.deepEqual([...perSite.values()], [1, 1, 1]); // never two at once on a site
  assert.ok(mostAtOnce > 1, "different sites are checked at the same time");
  assert.deepEqual(pauses, [1500, 1500, 1500]); // a.it: 2 pauses, b.it: 1, c.it: none
});

test("a 404 from a site whose home page is also 404 is blocked, not dead", async () => {
  const fetchFn = (async (url: string) => {
    if (url.startsWith("https://down.it/")) return new Response("", { status: 404 }); // home too
    if (url === "https://up.it/") return new Response("home");
    if (url === "https://up.it/gone") return new Response("", { status: 404 });
    return new Response("ok");
  }) as unknown as typeof fetch;
  const targets = ["https://down.it/a", "https://down.it/b", "https://up.it/gone", "https://up.it/ok"].map((url) => ({ url, refs: ["p: fonte"] }));
  const results = await checkTargets(targets, fetchFn, { sleep: async () => {} });
  assert.deepEqual(
    results.map((r) => [r.target.url, r.status, r.detail]),
    [
      ["https://down.it/a", "blocked", "HTTP 404, anche per la home del sito"],
      ["https://down.it/b", "blocked", "HTTP 404, anche per la home del sito"],
      ["https://up.it/gone", "unreachable", "HTTP 404"],
      ["https://up.it/ok", "ok", undefined],
    ],
  );
  const text = report(results, "2026-10-26");
  assert.match(text, /## Non raggiungibili \(1\)[\s\S]*up\.it\/gone/);
  assert.match(text, /## Bloccati dal sito \(2\)[\s\S]*down\.it\/a/);
  // Blocked pages alone don't make a report, and count as unchecked.
  assert.equal(report(results.filter((r) => r.status === "blocked"), "2026-10-26"), "");
  assert.match(inconclusive(results.filter((r) => r.status !== "ok"))!, /3 indirizzi su 3/);
});

test("documents with a sha256 every night; each page on one fixed night of the week", () => {
  const pages = Array.from({ length: 70 }, (_, i) => ({ url: `https://x.it/p${i}`, refs: ["p: fonte"] }));
  const forms = [{ url: "https://x.it/mod.pdf", sha256: sha("v1"), refs: ["p: modulo"] }];
  const all = [...forms, ...pages];
  const day = dayNumber("2026-10-26");
  const nights = Array.from({ length: 7 }, (_, n) => tonight(all, day + n));
  for (const night of nights) {
    assert.ok(night.includes(forms[0]), "the form is checked every night");
    assert.ok(night.length - 1 < 30, "only a share of the pages");
  }
  // Over a week every page is checked exactly once, and a week later the same night again.
  const counts = pages.map((p) => nights.filter((night) => night.includes(p)).length);
  assert.ok(counts.every((c) => c === 1));
  assert.deepEqual(tonight(all, day + 7), nights[0]);
  assert.equal(dayNumber("2026-10-27") - dayNumber("2026-10-26"), 1);
});

test("requests carry the last ETag and Last-Modified; a 304 is unchanged, and keeps them", async () => {
  const seen: Record<string, Record<string, string>> = {};
  const fetchFn = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    seen[url] = headers;
    if (url.endsWith("same.pdf") && headers["if-none-match"] === '"v1"') return new Response(null, { status: 304 });
    if (url.endsWith("new.pdf")) return new Response("v2", { headers: { etag: '"v2"' } });
    return new Response("<html>", { headers: { etag: '"p2"', "last-modified": "Mon, 26 Oct 2026 08:00:00 GMT" } });
  }) as unknown as typeof fetch;
  const same = { url: "https://x.it/same.pdf", sha256: sha("v1"), refs: ["p: modulo"] };
  const changed = { url: "https://x.it/new.pdf", sha256: sha("v1"), refs: ["p: modulo"] };
  const page = { url: "https://x.it/page", refs: ["p: fonte"] };
  const stored = { etag: '"v1"', lastModified: "Sun, 25 Oct 2026 08:00:00 GMT" };
  const validators = new Map<string, Validators>([
    [targetKey(same), stored],
    [targetKey(changed), { etag: '"v1"' }],
  ]);
  const results = await checkTargets([same, changed, page], fetchFn, { validators, sleep: async () => {} });
  assert.equal(seen["https://x.it/same.pdf"]["if-none-match"], '"v1"');
  assert.equal(seen["https://x.it/same.pdf"]["if-modified-since"], "Sun, 25 Oct 2026 08:00:00 GMT");
  assert.equal(seen["https://x.it/page"]["if-none-match"], undefined);
  assert.deepEqual(
    results.map((r) => [r.status, r.validators]),
    [
      ["ok", stored], // 304: unchanged, same validators
      ["changed", undefined], // no validators kept from content that didn't match
      ["ok", { etag: '"p2"', lastModified: "Mon, 26 Oct 2026 08:00:00 GMT" }],
    ],
  );
  assert.equal(results[0].validators, stored);
  // A document's state is keyed by its sha256 too, so a re-verified one starts afresh.
  assert.notEqual(targetKey(same), targetKey({ ...same, sha256: sha("v2") }));
});

test("the saved state carries results across nights; old and uncited ones drop out", () => {
  const a = { url: "https://x.it/a", refs: ["p: fonte"] };
  const b = { url: "https://x.it/b", refs: ["p: fonte"] };
  const gone = { url: "https://x.it/gone", refs: ["p: fonte"] };
  const state: State = {
    [a.url]: { status: "unreachable", detail: "HTTP 404", checkedOn: "2026-10-22", wayback: "nessuna copia nell'archivio" },
    [b.url]: { status: "unreachable", detail: "HTTP 404", checkedOn: "2026-10-10" },
    [gone.url]: { status: "ok", checkedOn: "2026-10-25" },
  };
  const next = merge(state, [{ target: b, status: "ok", validators: { etag: '"1"' } }], "2026-10-26", [a, b]);
  assert.deepEqual(Object.keys(next).sort(), [a.url, b.url]); // gone is no longer cited
  assert.deepEqual(next[b.url], { status: "ok", checkedOn: "2026-10-26", validators: { etag: '"1"' } });
  // An archive answer keeps the date it was asked, however often it's reused.
  const asked = merge({}, [{ target: a, status: "unreachable", wayback: "nessuna copia nell'archivio" }], "2026-10-20", [a]);
  const reused = merge(asked, [{ target: a, status: "unreachable", wayback: "nessuna copia nell'archivio" }], "2026-10-26", [a]);
  assert.equal(reused[a.url].waybackOn, "2026-10-20");
  const fresh = merge(reused, [{ target: a, status: "unreachable", wayback: "copia del 2026-10-27 (HTTP 200): …" }], "2026-10-28", [a]);
  assert.equal(fresh[a.url].waybackOn, "2026-10-28");
  const latest = known(next, [a, b], "2026-10-26");
  assert.deepEqual(latest.map((r) => [r.target.url, r.status, r.checkedOn]), [
    [a.url, "unreachable", "2026-10-22"],
    [b.url, "ok", undefined],
  ]);
  // A result older than the rotation (and a day's grace) is forgotten.
  assert.deepEqual(known(next, [a], "2026-11-01"), []);
  const text = report(latest, "2026-10-26");
  assert.match(text, /https:\/\/x\.it\/a \(HTTP 404, controllato il 2026-10-22\)\n {2}- Wayback Machine: nessuna copia nell'archivio/);
});

test("the Wayback Machine gives a second opinion on pages that failed, one lookup at a time", async () => {
  const asked: string[] = [];
  let throttled = false;
  const fetchFn = (async (url: string) => {
    asked.push(url);
    const page = decodeURIComponent(url.split("url=")[1].split("&")[0]);
    if (page === "https://x.it/blocked") {
      return Response.json([
        ["timestamp", "statuscode", "original"],
        ["20261020093000", "200", "https://x.it/blocked"],
      ]);
    }
    if (page === "https://x.it/busy" && !throttled) {
      throttled = true;
      return new Response("", { status: 429 });
    }
    if (page === "https://x.it/busy") return Response.json([["timestamp", "statuscode", "original"], ["20260101000000", "301", "https://x.it/busy"]]);
    if (page === "https://x.it/down") throw new TypeError("fetch failed");
    return Response.json([]);
  }) as unknown as typeof fetch;
  const failed = (url: string, status: Result["status"] = "unreachable"): Result => ({ target: { url, refs: [] }, status, detail: "HTTP 404" });
  const results: Result[] = [
    { target: { url: "https://x.it/ok", refs: [] }, status: "ok" },
    failed("https://x.it/blocked", "blocked"),
    failed("https://x.it/gone"),
    failed("https://x.it/busy"),
    failed("https://x.it/down"),
    failed("https://x.it/known"),
    { target: { url: "https://x.it/form.pdf", refs: [] }, status: "changed", detail: "sha256 …" },
  ];
  const pauses: number[] = [];
  const out = await secondOpinion(results, fetchFn, {
    saved: new Map([["https://x.it/known", "copia del 2026-10-01 (HTTP 200): https://web.archive.org/web/1/https://x.it/known"]]),
    sleep: async (ms) => void pauses.push(ms),
  });
  assert.ok(asked.every((u) => u.startsWith("https://web.archive.org/cdx/search/cdx?url=")));
  assert.equal(asked.length, 5); // 4 failed pages, one retried after a 429; the saved one isn't asked
  assert.deepEqual(pauses, [1000, 1000, 10000, 1000]);
  assert.deepEqual(out.map((r) => r.wayback), [
    undefined,
    "copia del 2026-10-20 (HTTP 200): https://web.archive.org/web/20261020093000/https://x.it/blocked",
    "nessuna copia nell'archivio",
    "copia del 2026-01-01 (HTTP 301): https://web.archive.org/web/20260101000000/https://x.it/busy",
    undefined, // the lookup failed: nothing said
    "copia del 2026-10-01 (HTTP 200): https://web.archive.org/web/1/https://x.it/known",
    undefined,
  ]);
  assert.equal((await secondOpinion(results, fetchFn, { sleep: async () => {}, limit: 1 })).filter((r) => r.wayback).length, 1);
});
