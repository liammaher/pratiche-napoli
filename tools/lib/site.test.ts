import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildSite, esc, firstSentence, time, type Procedure, type Situation, type SiteOptions } from "./site.ts";
import { ROOT, loadRegistry, todayInRome, validateDir, validateSituations } from "./validate.ts";

const opts: SiteOptions = {
  baseUrl: "https://example.org/pratiche",
  repoUrl: "https://github.com/example/pratiche",
  built: new Date("2026-10-26T10:00:00Z"),
  css: "body{}",
  schema: "{}",
  fields: "{}",
};

const library = validateDir(path.join(ROOT, "procedures"), loadRegistry(), todayInRome()).map((r) => r.doc as Procedure);
const situations = validateSituations(path.join(ROOT, "situations"), new Set(library.map((p) => p.id)), todayInRome()).map(
  (r) => r.doc as Situation,
);
const files = buildSite(library, opts, situations);
const reports = { url: "https://europe-west8-example.cloudfunctions.net/submitReport", contact: "privacy@example.org", script: "// report.js" };
const withForm = buildSite(library, { ...opts, reports }, situations);

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

test("two pages at one path, one folder naming two enti, or two folders one ente stop the build", () => {
  assert.throws(() => buildSite([minimal(), minimal({ id: "napoli/comune", ente: { name: "Napoli" } })], opts), /two pages would be written at napoli\/comune\/index\.html/);
  const suap = minimal({ id: "napoli/comune/other", ente: { name: "Comune di Napoli – SUAP" } });
  assert.throws(() => buildSite([minimal(), suap], opts), /napoli\/comune name different enti: Comune di Napoli \/ Comune di Napoli – SUAP/);
  // The home page would have two sections called Comune di Napoli.
  const elsewhere = minimal({ id: "napoli/polizia-locale/other" });
  assert.throws(() => buildSite([minimal(), elsewhere], opts), /napoli\/comune and napoli\/polizia-locale are both Comune di Napoli: one folder per ente/);
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
  for (const missing of ["<form", 'class="flag"', "report.js", "#racconta"]) assert.ok(!html.includes(missing), missing);
  // Until the form is on, errors can still be reported, publicly, with a warning.
  assert.ok(html.includes("Segnala un errore su GitHub</a> (la segnalazione è pubblica: non scrivere dati personali)"));
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
  // Each document is a group named by the document, so "sì" and "no" aren't anonymous.
  assert.ok(body.includes('<fieldset class="doc"><legend>Mod. 1 &quot;TARI&quot;</legend><input type="hidden" name="documents[0][name]" value="Mod. 1 &quot;TARI&quot;">'));
  assert.ok(body.includes('<option value="pagina">Tutta la pagina, o non so</option>'));
  assert.ok(body.includes('pattern="[0-9]{1,3}(\\.[0-9]{3})+(,[0-9]{1,2})?|[0-9]+([.,][0-9]{1,2})?"'));
  assert.ok(!html.includes("issues/new"));
  assert.ok(body.includes('name="documents[1][asked]" value="no"'));
  assert.ok(body.includes('<option value="2026-10">ottobre 2026</option>'));
  // The last 12 months: older reports are refused, having left the figures' window.
  assert.ok(body.includes('<option value="2025-11">novembre 2025</option>'));
  assert.ok(!body.includes('value="2025-10"'));
  for (const [id, title] of [["in-breve", "In breve"], ["come", "Come si presenta?"], ["documenti", "Quali documenti servono?"]]) {
    assert.ok(body.includes(`<option value="${id}">${esc(title)}</option>`), id);
    // The link sits under the heading, not in it, and doesn't reload the page.
    assert.ok(html.includes(`<h2>${esc(title)}</h2>\n<p class="flag"><a href="#racconta" data-section="${id}">Segnala un errore in questa parte</a></p>`), id);
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

test("the amount pattern accepts what Italians write and nothing else", () => {
  const html = buildSite([minimal()], { ...opts, reports }).get("napoli/comune/test/index.html")!;
  // Browsers match the pattern against the whole value.
  const pattern = new RegExp(`^(?:${html.match(/name="paid_eur" inputmode="decimal" pattern="([^"]+)"/)![1].replace(/&#39;/g, "'")})$`);
  for (const ok of ["16", "66,50", "16.5", "1.250", "1.250,50", "12500"]) assert.match(ok, pattern, ok);
  for (const bad of ["1.2.3", "12,345", "€16", "1,250.50", ""]) assert.doesNotMatch(bad, pattern, bad);
});

test("the privacy page mentions the host's access logs and calls the IP code pseudonymous", () => {
  for (const site of [files, withForm]) {
    const privacy = site.get("privacy/index.html")!;
    assert.ok(privacy.includes("log di accesso"));
    assert.ok(privacy.includes("codice pseudonimo"));
    assert.ok(!privacy.includes("senza lasciare dati") && !privacy.includes("non permette di risalirci"));
  }
});

test("the privacy page claims no more than the figures do", () => {
  const privacy = withForm.get("privacy/index.html")!;
  // A group of 3 doesn't stop everything, and the page says what it leaves.
  assert.ok(!privacy.includes("non si risale a nessuno"));
  assert.ok(privacy.includes("Cosa resta possibile"));
  // Its example is a figure the rounding can give (23 days is shown as 25).
  assert.ok(privacy.includes("circa 25 giorni via PEC, 7 racconti"));
  assert.ok(privacy.includes("restano nella cronologia pubblica"));
  // What a group gives away is a count, and the review only helps against fakes.
  assert.ok(privacy.includes("tutti e 3 sono stati respinti"));
  assert.ok(privacy.includes("non contro il primo"));
  assert.ok(privacy.includes("le correzioni alla pagina"));
});

test("what people reported shows in In breve and its own section, never as official", () => {
  const p = minimal({
    documents: [{ name: "Modulo", required: true }],
    reported: {
      generated: "2026-10-25",
      period: { from: "2025-11", to: "2026-10" },
      count: 7,
      outcomes: { completata: 4, respinta: 3 },
      channels: [{ type: "pec", count: 7, days_to_answer: { median: 23, n: 4 } }],
      paid_eur: { median: 66, n: 3 },
      documents: [{ name: "Modulo", asked: 3, of: 3 }],
      extra_documents: [{ text: "Planimetria", count: 3 }],
      tips: ["Mandare la PEC al mattino"],
      basis: [],
    },
  });
  const html = buildSite([p], opts).get("napoli/comune/test/index.html")!;
  assert.ok(html.includes(`<dt>Tempi reali</dt><dd>circa 23 giorni via PEC (4 racconti), secondo chi l'ha fatta. <a href="#esperienze">Racconti</a></dd>`));
  const section = html.match(/<section id="esperienze">(.*?)<\/section>/s)![1];
  assert.ok(section.includes("<h2>Com&#39;è andata ad altri</h2>"));
  assert.ok(section.includes("Da 7 racconti di chi ha fatto la pratica tra novembre 2025 e ottobre 2026"));
  assert.ok(section.includes("Non sono una fonte ufficiale"));
  assert.ok(section.includes("4 andate a buon fine, 3 respinte."));
  assert.ok(section.includes("<strong>Risposta via PEC</strong>: circa 23 giorni (4 racconti)."));
  assert.ok(section.includes("<strong>Pagato in tutto</strong>: circa 66\u00a0€ (3 racconti)."));
  assert.ok(section.includes("Modulo, a 3 su 3"));
  assert.ok(section.includes("Planimetria (3 racconti)"));
  assert.ok(section.includes("<li>Mandare la PEC al mattino</li>"));
  // Never in the search snippet or the structured data.
  assert.ok(!html.match(/<meta name="description" content="[^"]*racconti/));
  assert.ok(!html.match(/<script type="application\/ld\+json">[^<]*racconti/));
  // Without reports, no section and no row.
  const none = buildSite([minimal()], opts).get("napoli/comune/test/index.html")!;
  assert.ok(!none.includes('id="esperienze"') && !none.includes("Tempi reali"));
});

test("same-day answers and no wait read naturally", () => {
  const stat = (median: number) => ({ median, n: 3 });
  const p = minimal({
    reported: {
      generated: "2026-10-25",
      period: { from: "2026-09", to: "2026-09" },
      count: 3,
      channels: [{ type: "portal", count: 3, days_to_answer: stat(0) }],
      desk_wait_minutes: stat(0),
      paid_eur: stat(16),
      basis: [],
    },
  });
  const html = buildSite([p], opts).get("napoli/comune/test/index.html")!;
  assert.ok(html.includes("<dd>in giornata via Portale online (3 racconti), secondo chi"));
  assert.ok(html.includes("<strong>Risposta via Portale online</strong>: in giornata (3 racconti)."));
  assert.ok(html.includes("<strong>Attesa allo sportello</strong>: nessuna attesa (3 racconti)."));
  assert.ok(html.includes("<strong>Pagato in tutto</strong>: circa 16\u00a0€ (3 racconti)."));
  assert.ok(!html.includes("0 giorni"));
});

test("situation pages list their procedures with each one's own deadline, never a new fact", () => {
  const first = minimal({ deadline: { rules: [{ text: "Entro 90 giorni.", status: "unverified" }] } });
  const second = minimal({ id: "napoli/comune/other", headline: "Altra pratica di prova", updated: "2026-10-26" });
  const s: Situation = {
    id: "apro-test",
    headline: "Aprire un test a Napoli: le pratiche",
    aka: ["test"],
    updated: "2026-10-20",
    intro: "Le pratiche di chi apre un test.",
    steps: [
      { procedure: "napoli/comune/test", when: "La prima" },
      { procedure: "napoli/comune/other", when: "La seconda" },
    ],
  };
  const site = buildSite([first, second], opts, [s]);
  const page = site.get("situazioni/apro-test/index.html")!;
  assert.ok(page.includes('<li><a href="../../napoli/comune/test/">Test</a>\n<p>La prima</p>'));
  assert.ok(page.includes('<p class="note">Scadenza: Entro 90 giorni. <span class="badge">da verificare</span></p>'));
  assert.ok(!page.includes('class="cite"'));
  // The page changed when its newest procedure did.
  assert.ok(page.includes(`Aggiornata il ${time("2026-10-26")}`));
  assert.ok(site.get("sitemap.xml")!.includes(`<loc>${opts.baseUrl}/situazioni/apro-test/</loc><lastmod>2026-10-26</lastmod>`));
  const ld = JSON.parse(page.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)![1]);
  assert.deepEqual(ld.mainEntity.itemListElement.map((i: { url: string }) => i.url), [`${opts.baseUrl}/napoli/comune/test/`, `${opts.baseUrl}/napoli/comune/other/`]);
  // Linked from the home page, the procedures and the index, and listed for AIs.
  assert.ok(site.get("index.html")!.includes('<a href="situazioni/apro-test/">Aprire un test a Napoli: le pratiche</a>'));
  assert.ok(site.get("napoli/comune/test/index.html")!.includes('<p class="meta">Fa parte di: <a href="../../../situazioni/apro-test/">Aprire un test a Napoli: le pratiche</a></p>'));
  assert.ok(site.get("situazioni/index.html")!.includes('<a href="../situazioni/apro-test/">'));
  assert.ok(site.get("llms.txt")!.includes("## Situations"));
  assert.deepEqual(JSON.parse(site.get("procedures.json")!).situations[0].procedures, ["napoli/comune/test", "napoli/comune/other"]);
});

test("the about and updates pages are built and linked from every page", () => {
  const about = files.get("come-lavoriamo/index.html")!;
  for (const level of ["L0", "L1", "L2", "L3"]) assert.ok(about.includes(`<strong>${level}</strong>`), level);
  assert.ok(about.includes('"@type":"AboutPage"'));
  assert.ok(about.includes("è pubblica: non scrivere dati personali"));
  assert.ok(withForm.get("come-lavoriamo/index.html")!.includes("mailto:privacy@example.org"));
  const updates = files.get("aggiornamenti/index.html")!;
  const dates = [...updates.matchAll(/<li><time datetime="([\d-]+)">/g)].map((m) => m[1]);
  assert.ok(dates.length > 0 && dates.length <= 50);
  assert.deepEqual(dates, [...dates].sort().reverse());
  assert.ok(updates.includes(`${opts.repoUrl}/commits/main/procedures/`));
  for (const [file, content] of files) {
    if (file.endsWith(".html") && file !== "404.html") {
      assert.ok(content.includes('come-lavoriamo/">Come lavoriamo</a>') && content.includes('aggiornamenti/">Aggiornamenti</a>'), file);
    }
  }
});

test("the description ends the first sentence where the sentence ends, not at an abbreviation", () => {
  assert.equal(firstSentence("Si presenta con il Mod. 1 entro 90 giorni. Poi si paga."), "Si presenta con il Mod. 1 entro 90 giorni.");
  assert.equal(firstSentence("Rientra nell'Allegato I del D.P.R. 151/2011 (art. 4). Altro."), "Rientra nell'Allegato I del D.P.R. 151/2011 (art. 4).");
  assert.equal(firstSentence("Locazione breve, art. 4 D.L. 50/2017: si comunica. Poi"), "Locazione breve, art. 4 D.L. 50/2017: si comunica.");
  assert.equal(firstSentence("Una sola frase senza punto"), "Una sola frase senza punto");
  assert.equal(firstSentence("Lo fai tu. Poi lo mandi."), "Lo fai tu.");
  assert.equal(firstSentence('Si chiama "SCIA unica." Poi si paga.'), 'Si chiama "SCIA unica."');
  assert.equal(firstSentence("Servono moduli, ricevute ecc. Poi si invia."), "Servono moduli, ricevute ecc.");
  assert.equal(firstSentence("Si paga ogni anno. 2026: entro il 16 giugno."), "Si paga ogni anno.");
  assert.equal(firstSentence("Entro il 31 dic. 2026 va pagata. Poi"), "Entro il 31 dic. 2026 va pagata.");
  const deadline = { rules: [{ text: "Entro 90 giorni dall'inizio.", status: "verified" as const, source: "page" }] };
  const html = buildSite([minimal({ summary: "Va fatta con il Mod. 1 entro 90 giorni. Altro.", deadline })], opts).get("napoli/comune/test/index.html")!;
  // The deadline the sentence already gives isn't added again.
  assert.match(html, /<meta name="description" content="Va fatta con il Mod\. 1 entro 90 giorni\.">/);
  // A fact sharing only its opening words with the sentence is still added.
  const strada = { rules: [{ text: "Codice della Strada: pagare entro 60 giorni.", status: "verified" as const, source: "page" }] };
  const multa = buildSite([minimal({ summary: "Per il Codice della Strada, una multa si paga o si contesta.", deadline: strada })], opts).get("napoli/comune/test/index.html")!;
  assert.match(multa, /content="Per il Codice della Strada, una multa si paga o si contesta\. Codice della Strada: pagare entro 60 giorni\."/);
  // A long sentence is shortened to make room for the deadline, which is never cut.
  const long = "Chi apre un'attività deve presentare la dichiarazione con il modulo previsto, compilato in ogni parte e firmato, allo sportello o per PEC, con i documenti richiesti e la ricevuta.";
  const room = buildSite([minimal({ summary: long, deadline: { rules: [{ text: "Entro 90 giorni dall'inizio.", status: "verified" as const, source: "page" }] } })], opts).get("napoli/comune/test/index.html")!;
  const description = room.match(/<meta name="description" content="([^"]*)"/)![1];
  assert.ok(description.endsWith("… Entro 90 giorni dall&#39;inizio."), description);
  assert.ok(description.length <= 210);
});

test("access reads naturally, also without credentials", () => {
  const channels = [{ type: "portal", purpose: "procedure" as const, name: "Portale", auth: ["none", "spid"] }];
  const html = buildSite([minimal({ channels })], opts).get("napoli/comune/test/index.html")!;
  assert.ok(html.includes("Sì: Portale online (Portale), con SPID o senza credenziali."));
  assert.ok(html.includes("<p>Accesso con SPID o senza credenziali</p>"));
  assert.ok(!html.includes("con senza"));
});

test("long headlines aren't lengthened by the site's name; static pages carry no lastmod", () => {
  const long = "Una pratica dal titolo molto lungo, come quelli che si cercano davvero";
  const site = buildSite([minimal({ headline: long })], opts);
  assert.ok(site.get("napoli/comune/test/index.html")!.includes(`<title>${long}</title>`));
  const sitemap = site.get("sitemap.xml")!;
  assert.ok(sitemap.includes(`<url><loc>${opts.baseUrl}/privacy/</loc></url>`));
  assert.ok(sitemap.includes(`<url><loc>${opts.baseUrl}/come-lavoriamo/</loc></url>`));
});
