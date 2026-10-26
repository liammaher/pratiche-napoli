import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSite, esc, time, type Procedure, type SiteOptions } from "./site.ts";
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
const reports = { url: "https://europe-west8-example.cloudfunctions.net/submitReport", contact: "privacy@example.org", script: "// report.js" };
const withForm = buildSite(library, { ...opts, reports });

function minimal(over: Partial<Procedure> = {}): Procedure {
  return {
    id: "napoli/comune/test",
    title: "Test",
    updated: "2026-10-25",
    summary: "Una procedura di prova.",
    ente: { name: "Comune di Napoli" },
    applies_to: { events: ["home"], audience: ["resident"] },
    channels: [{ type: "pec", purpose: "procedure", address: "ufficio@pec.comune.napoli.it" }],
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

test("every relative link points to a page or file the site has, with or without the form", () => {
  for (const site of [files, withForm]) {
    for (const [file, content] of site) {
      if (!file.endsWith(".html") || file === "404.html") continue;
      for (const [, href] of content.matchAll(/(?:href|src)="([^"]+)"/g)) {
        // ?sezione=…#racconta links stay on the same page.
        if (/^(https?:|mailto:|tel:|#|\?)/.test(href)) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), href.replace(/#.*/, "")));
        const resolved = href.endsWith("/") || target === "." ? path.posix.join(target === "." ? "" : target, "index.html") : target;
        assert.ok(site.has(resolved), `${file} links to ${href} (${resolved})`);
      }
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
  const site = buildSite([minimal({ channels: [{ type: "phone", purpose: "info", address: "081 7953748 / 081 7953784 – 081 7953768" }] })], opts);
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
      { type: "desk", purpose: "procedure", name: "Sportello" },
      { type: "pec", purpose: "info", notes: "Solo per informazioni." },
      { type: "portal", purpose: "procedure", name: "POTESs", auth: ["spid", "cie"] },
    ],
    documents: [
      { name: "Modulo", required: true },
      { name: "Visura", required: false },
    ],
    steps: [
      { do: "Compila", who: "anyone" },
      { do: "Firma il modulo.", who: "owner", human_only: true },
      { do: "Assevera i lavori", who: "professional", human_only: true },
      { do: "Paga l'F24", who: "owner", human_only: true },
    ],
  });
  const html = buildSite([p], opts).get("napoli/comune/test/index.html")!;
  const box = html.match(/<section id="in-breve" class="quick">(.*?)<\/section>/s)![1];
  const cite = '<a class="cite" href="#fonte-page">[1]</a>';
  assert.ok(box.includes(`<dt>Scadenza</dt><dd>Entro 90 giorni. ${cite} <a href="#scadenza">Dettagli</a></dd>`));
  assert.ok(box.includes(`<dt>Costo</dt><dd>Gratuita. ${cite}</dd>`));
  assert.ok(box.includes('<dt>Tempi</dt><dd>Risposta in 30 giorni. <span class="badge">da verificare</span></dd>'));
  // The information-only PEC is not a way to do it online.
  assert.ok(box.includes('<dt>Si può fare online?</dt><dd>Sì: Portale online (POTESs), con SPID, CIE. <a href="#come">'));
  assert.ok(box.includes(`<dt>Appuntamento</dt><dd>Non serve. ${cite}</dd>`));
  assert.ok(box.includes("<dt>Documenti</dt><dd>1 obbligatorio."));
  // Only the owner's steps, not the professional's.
  assert.ok(box.includes("<dt>Cosa devi fare tu</dt><dd>Firma il modulo; Paga l&#39;F24. <a"));
  for (const id of ["scadenza", "come", "documenti", "passaggi"]) assert.ok(html.includes(`<section id="${id}">`), id);
  // Unverified facts stay out of the description, which search snippets show without badges.
  assert.match(html, /<meta name="description" content="Una procedura di prova\. Entro 90 giorni\. Gratuita\.">/);
  // Channels that carry out the procedure come first; the others say what they are for.
  const come = html.match(/<section id="come">(.*?)<\/section>/s)![1];
  assert.ok(come.indexOf("POTESs") < come.indexOf("<h3>PEC"));
  assert.ok(come.includes('<h3>PEC <span class="badge soft">solo informazioni</span></h3>'));
});

test("several deadline rules are summed up, never cut to the first", () => {
  const rules = [
    { text: "Zona C: prima di aprire.", status: "verified" as const, source: "page" },
    { text: "Zone A e B: dopo l'autorizzazione.", status: "verified" as const, source: "page" },
  ];
  const without = buildSite([minimal({ deadline: { rules } })], opts).get("napoli/comune/test/index.html")!;
  assert.ok(!without.match(/<section id="in-breve".*?<\/section>/s)![0].includes("<dt>Scadenza</dt>"));
  const summary = { text: "Prima di aprire in zona C; nelle zone A e B dopo l'autorizzazione.", status: "disputed" as const, source: "page" };
  const html = buildSite([minimal({ deadline: { summary, rules } })], opts).get("napoli/comune/test/index.html")!;
  assert.ok(html.includes('<dt>Scadenza</dt><dd>Prima di aprire in zona C; nelle zone A e B dopo l&#39;autorizzazione. <span class="badge">fonti in contrasto</span>'));
  assert.match(html, /<meta name="description" content="Una procedura di prova\.">/);
});

test("In breve says when a procedure can't be done online, and leaves out what isn't known", () => {
  const channels = [
    { type: "desk", purpose: "procedure" as const },
    { type: "post", purpose: "procedure" as const },
    { type: "phone", purpose: "info" as const },
    { type: "email", purpose: "info" as const },
  ];
  const html = buildSite([minimal({ channels })], opts).get("napoli/comune/test/index.html")!;
  const box = html.match(/<section id="in-breve" class="quick">(.*?)<\/section>/s)![1];
  assert.ok(box.includes("<dd>No: sportello, posta."));
  for (const missing of ["Scadenza", "Costo", "Tempi", "Appuntamento", "Documenti", "Cosa devi fare tu"]) {
    assert.ok(!box.includes(`<dt>${missing}</dt>`), missing);
  }
});

test("without a reports URL there is no form, no Segnala link and no report.js", () => {
  const html = files.get("napoli/comune/tari-iscrizione-uso-abitativo/index.html")!;
  for (const missing of ["<form", 'class="flag"', "report.js", "#racconta", "issues/new"]) assert.ok(!html.includes(missing), missing);
  assert.ok(!files.has("report.js"));
  assert.ok(files.get("privacy/index.html")!.includes("non è ancora attivo"));
  assert.ok(files.get("grazie/index.html")!.includes('<meta name="robots" content="noindex">'));
  for (const [file, content] of files) if (file.endsWith(".html") && file !== "404.html") assert.ok(content.includes('privacy/">Privacy</a>'), file);
});

test("the report form is built from the procedure's own channels, documents and sections", () => {
  const p = minimal({
    channels: [
      { type: "portal", purpose: "procedure", name: "POTESs" },
      { type: "pec", purpose: "info" },
    ],
    documents: [
      { name: "Mod. 1 \"TARI\"", required: true },
      { name: "Visura", required: false },
    ],
  });
  const site = buildSite([p], { ...opts, reports });
  const html = site.get("napoli/comune/test/index.html")!;
  const form = html.match(/<form method="post" action="([^"]+)" data-report>(.*?)<\/form>/s)!;
  assert.equal(form[1], reports.url);
  const body = form[2];
  assert.ok(body.includes('<input type="hidden" name="procedure" value="napoli/comune/test">'));
  assert.ok(body.includes('<option value="POTESs" data-type="portal">POTESs</option><option value="PEC" data-type="pec">PEC</option><option value="altro">Altro</option>'));
  assert.ok(body.includes('<input type="hidden" name="documents[0][name]" value="Mod. 1 &quot;TARI&quot;">'));
  assert.ok(body.includes('name="documents[1][asked]" value="no"'));
  assert.ok(body.includes('<option value="2026-10">ottobre 2026</option>'));
  assert.ok(body.includes('<option value="2024-11">novembre 2024</option>'));
  assert.ok(!body.includes('value="2024-10"'));
  for (const [id, title] of [["in-breve", "In breve"], ["come", "Come si presenta?"], ["documenti", "Quali documenti servono?"]]) {
    assert.ok(body.includes(`<option value="${id}">${esc(title)}</option>`), id);
    assert.ok(html.includes(`<a class="flag" href="?sezione=${id}#racconta" data-section="${id}">Segnala</a>`), id);
  }
  assert.ok(body.includes('name="website"'));
  assert.ok(html.includes('<script src="../../../report.js" defer></script>'));
  assert.equal(site.get("report.js"), reports.script);
  assert.ok(site.get("privacy/index.html")!.includes('<a href="mailto:privacy@example.org">privacy@example.org</a>'));
});

test("section ids fit the report schema's pattern for claim_feedback sections", () => {
  const schema = JSON.parse(readFileSync(path.join(ROOT, "contract", "report.schema.json"), "utf8"));
  const pattern = new RegExp(schema.properties.claim_feedback.items.properties.section.pattern);
  for (const [, id] of withForm.get("napoli/comune/tari-iscrizione-uso-abitativo/index.html")!.matchAll(/data-section="([^"]+)"/g)) {
    assert.match(id, pattern);
  }
});
