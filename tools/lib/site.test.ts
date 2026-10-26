import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { buildSite, time, type Procedure, type SiteOptions } from "./site.ts";
import { ROOT, loadRegistry, todayInRome, validateDir } from "./validate.ts";

const opts: SiteOptions = {
  baseUrl: "https://example.org/pratiche",
  repoUrl: "https://github.com/example/pratiche",
  built: new Date("2026-10-26T10:00:00Z"),
  css: "body{}",
  schema: "{}",
  fields: "{}",
};

const library = validateDir(path.join(ROOT, "procedures"), loadRegistry(), todayInRome()).map((r) => r.doc as Procedure);
const files = buildSite(library, opts);

function minimal(over: Partial<Procedure> = {}): Procedure {
  return {
    id: "napoli/comune/test",
    title: "Test",
    updated: "2026-10-25",
    summary: "Una procedura di prova.",
    ente: { name: "Comune di Napoli" },
    applies_to: { events: ["home"], audience: ["resident"] },
    channels: [{ type: "pec", address: "ufficio@pec.comune.napoli.it" }],
    steps: [{ do: "Invia", who: "owner" }],
    sources: [{ id: "page", label: "Pagina", url: "https://www.comune.napoli.it/", retrieved: "2026-10-25", official: true }],
    verification: { level: "L1", date: "2026-10-25", by: "test", method: "desk" },
    ...over,
  };
}

test("every procedure gets a page and a JSON file identical to its YAML", () => {
  for (const p of library) {
    assert.ok(files.has(`${p.id}/index.html`), p.id);
    assert.deepEqual(JSON.parse(files.get(`${p.id}.json`)!), p);
  }
});

test("each page shows and declares when its procedure was last updated", () => {
  for (const p of library) {
    const html = files.get(`${p.id}/index.html`)!;
    assert.ok(html.includes(`Aggiornata il ${time(p.updated)}`), p.id);
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]);
    assert.equal(ld.dateModified, p.updated);
    assert.equal(ld.lastReviewed, p.verification.date);
  }
});

test("the sitemap, JSON index and llms.txt carry the same dates", () => {
  const newest = library.map((p) => p.updated).sort().at(-1)!;
  const sitemap = files.get("sitemap.xml")!;
  assert.ok(sitemap.includes(`<loc>${opts.baseUrl}/</loc><lastmod>${newest}</lastmod>`));
  for (const p of library) assert.ok(sitemap.includes(`<loc>${opts.baseUrl}/${p.id}/</loc><lastmod>${p.updated}</lastmod>`), p.id);

  const index = JSON.parse(files.get("procedures.json")!);
  assert.equal(index.updated, newest);
  assert.equal(index.built, "2026-10-26T10:00:00.000Z");
  assert.equal(index.count, library.length);
  for (const p of library) {
    const entry = index.procedures.find((e: { id: string }) => e.id === p.id);
    assert.equal(entry.updated, p.updated);
    assert.equal(entry.json, `${opts.baseUrl}/${p.id}.json`);
  }
  assert.ok(files.get("llms.txt")!.includes(`Library last updated ${newest}.`));
  assert.ok(files.get("index.html")!.includes(`libreria aggiornata il ${time(newest)}`));
  assert.match(files.get("robots.txt")!, new RegExp(`Sitemap: ${opts.baseUrl}/sitemap.xml`));
});

test("every relative link points to a page or file the site has", () => {
  for (const [file, content] of files) {
    if (!file.endsWith(".html") || file === "404.html") continue;
    for (const [, href] of content.matchAll(/href="([^"]+)"/g)) {
      if (/^(https?:|mailto:|tel:|#)/.test(href)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), href.replace(/#.*/, "")));
      const resolved = href.endsWith("/") || target === "." ? path.posix.join(target === "." ? "" : target, "index.html") : target;
      assert.ok(files.has(resolved), `${file} links to ${href} (${resolved})`);
    }
  }
});

test("content is escaped, including inside the structured data", () => {
  const evil = "</script><script>alert(1)</script>";
  const site = buildSite([minimal({ title: `Titolo ${evil}`, summary: `Riassunto ${evil} & altro` })], opts);
  const html = site.get("napoli/comune/test/index.html")!;
  assert.equal(html.match(/<script/g)!.length, 1); // only the JSON-LD block
  assert.ok(html.includes("Titolo &lt;/script&gt;"));
  assert.ok(html.includes("\\u003c/script>"));
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]);
  assert.equal(ld.name, `Titolo ${evil}`);
});

test("claims show their status and cite their source by number", () => {
  const site = buildSite(
    [
      minimal({
        pitfalls: [
          { text: "Confermato.", status: "verified", source: "page" },
          { text: "Forse.", status: "unverified" },
          { text: "Dipende.", status: "disputed", source: "page" },
        ],
      }),
    ],
    opts,
  );
  const html = site.get("napoli/comune/test/index.html")!;
  assert.ok(html.includes('Confermato. <a class="cite" href="#fonte-page">[1]</a>'));
  assert.ok(html.includes('Forse. <span class="badge">da verificare</span>'));
  assert.ok(html.includes('Dipende. <span class="badge">fonti in contrasto</span>'));
  assert.ok(html.includes('<li id="fonte-page">[1]'));
});

test("dates are written in Italian, in the date given whatever the time zone", () => {
  assert.equal(time("2026-01-01"), '<time datetime="2026-01-01">1 gennaio 2026</time>');
  assert.equal(time("2026-10-25"), '<time datetime="2026-10-25">25 ottobre 2026</time>');
});

test("a phone field with several numbers links each one", () => {
  const site = buildSite([minimal({ channels: [{ type: "phone", address: "081 7953748 / 081 7953784 – 081 7953768" }] })], opts);
  const html = site.get("napoli/comune/test/index.html")!;
  assert.ok(
    html.includes(
      '<a href="tel:0817953748">081 7953748</a> / <a href="tel:0817953784">081 7953784</a> / <a href="tel:0817953768">081 7953768</a>',
    ),
  );
});

test("payment codes carry their status and source", () => {
  const payment = { method: "f24", codice_ente: "F839", codici_tributo: ["3944"], status: "unverified" as const, source: "page" };
  const html = buildSite([minimal({ payment })], opts).get("napoli/comune/test/index.html")!;
  const mark = ' <span class="badge">da verificare</span> <a class="cite" href="#fonte-page">[1]</a>';
  assert.ok(html.includes(`Codice ente: <code>F839</code>${mark}`));
  assert.ok(html.includes(`Codici tributo: <code>3944</code>${mark}`));
});

test("the home search looks only at titles and summaries", () => {
  const html = buildSite([minimal()], opts).get("index.html")!;
  assert.ok(html.includes('<li data-search="Test Una procedura di prova.">'));
  assert.ok(html.includes("li.dataset.search"));
});

test("two pages at one path, or one folder naming two enti, stop the build", () => {
  assert.throws(() => buildSite([minimal(), minimal({ id: "napoli/comune" })], opts), /two pages would be written at napoli\/comune\/index\.html/);
  const suap = minimal({ id: "napoli/comune/other", ente: { name: "Comune di Napoli – SUAP" } });
  assert.throws(() => buildSite([minimal(), suap], opts), /napoli\/comune name different enti: Comune di Napoli \/ Comune di Napoli – SUAP/);
});

test("the headline titles the page; the official name and everyday names come under it", () => {
  const p = minimal({ headline: "Come fare la prova a Napoli", aka: ["provina", "test"] });
  const site = buildSite([p], opts);
  const html = site.get("napoli/comune/test/index.html")!;
  assert.ok(html.includes("<title>Come fare la prova a Napoli | Pratiche Napoli</title>"));
  assert.ok(html.includes('<h1>Come fare la prova a Napoli</h1>\n<p class="official">Test</p>'));
  assert.ok(html.includes("Conosciuta anche come: provina, test"));
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]);
  assert.deepEqual(ld.about.alternateName, ["Come fare la prova a Napoli", "provina", "test"]);
  assert.ok(site.get("index.html")!.includes('data-search="Come fare la prova a Napoli Test provina test Una procedura di prova."'));
  assert.equal(JSON.parse(site.get("procedures.json")!).procedures[0].headline, "Come fare la prova a Napoli");
  assert.ok(site.get("llms.txt")!.includes("[Come fare la prova a Napoli]("));
});

test("In breve answers the first questions, with status and source", () => {
  const p = minimal({
    deadline: { rules: [{ text: "Entro 90 giorni.", status: "verified", source: "page" }] },
    cost: { text: "Gratuita.", status: "verified", source: "page" },
    duration: { text: "Risposta in 30 giorni.", status: "unverified" },
    appointment: { text: "Non serve.", status: "verified", source: "page" },
    channels: [
      { type: "desk", name: "Sportello" },
      { type: "portal", name: "POTESs", auth: ["spid", "cie"] },
    ],
    documents: [
      { name: "Modulo", required: true },
      { name: "Visura", required: false },
    ],
    steps: [
      { do: "Compila", who: "anyone" },
      { do: "Firma", who: "owner", human_only: true },
    ],
  });
  const html = buildSite([p], opts).get("napoli/comune/test/index.html")!;
  const box = html.match(/<section id="in-breve" class="quick">(.*?)<\/section>/s)![1];
  const cite = '<a class="cite" href="#fonte-page">[1]</a>';
  assert.ok(box.includes(`<dt>Scadenza</dt><dd>Entro 90 giorni. ${cite} <a href="#scadenza">Dettagli</a></dd>`));
  assert.ok(box.includes(`<dt>Costo</dt><dd>Gratuita. ${cite}</dd>`));
  assert.ok(box.includes('<dt>Tempi</dt><dd>Risposta in 30 giorni. <span class="badge">da verificare</span></dd>'));
  assert.ok(box.includes("<dt>Si può fare online?</dt><dd>Sì: Portale online (POTESs), con SPID, CIE."));
  assert.ok(box.includes(`<dt>Appuntamento</dt><dd>Non serve. ${cite}</dd>`));
  assert.ok(box.includes("<dt>Documenti</dt><dd>1 obbligatorio."));
  assert.ok(box.includes("<dt>Cosa devi fare tu</dt><dd>1 passaggio"));
  for (const id of ["scadenza", "come", "documenti", "passaggi"]) assert.ok(html.includes(`<section id="${id}">`), id);
  assert.match(html, /<meta name="description" content="Una procedura di prova\. Entro 90 giorni\. Gratuita\. Risposta in 30 giorni\.">/);
});

test("In breve says when a procedure can't be done online, and leaves out what isn't known", () => {
  const html = buildSite([minimal({ channels: [{ type: "desk" }, { type: "post" }] })], opts).get("napoli/comune/test/index.html")!;
  const box = html.match(/<section id="in-breve" class="quick">(.*?)<\/section>/s)![1];
  assert.ok(box.includes("<dd>No: sportello, posta."));
  for (const missing of ["Scadenza", "Costo", "Tempi", "Appuntamento", "Documenti"]) assert.ok(!box.includes(`<dt>${missing}</dt>`), missing);
});
