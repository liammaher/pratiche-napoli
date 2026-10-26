// Renders the library as a static site: one page and one JSON file per
// procedure, a page per ente, the home page, and the files that let search
// engines and AI assistants find and read it (sitemap, robots, llms.txt and a
// JSON index). Every page shows when its content was last updated, and the
// same dates go into the sitemap, the structured data and the JSON.
//
// Rendering is pure: buildSite returns path → content, the CLI writes it.
// Links between pages are relative, so the site works under any path; only
// canonical URLs, the sitemap and the JSON index use the base URL.

// Procedures are validated before they get here; this is the subset rendered.
type Status = "verified" | "unverified" | "disputed";
interface Claim {
  text: string;
  status: Status;
  source?: string;
}
interface Channel {
  type: string;
  name?: string;
  url?: string;
  address?: string;
  auth?: string[];
  hours?: string;
  booking?: string;
  receipt?: string;
  preferred?: boolean;
  notes?: string;
  source?: string;
}
interface Source {
  id: string;
  label: string;
  url?: string;
  retrieved: string;
  page_updated?: string;
  official?: boolean;
  notes?: string;
}
export interface Procedure {
  id: string;
  title: string;
  updated: string;
  summary: string;
  ente: { name: string; office?: string };
  applies_to: { events: string[]; audience: string[]; sectors?: string[]; conditions?: Claim[] };
  legal_basis?: Claim[];
  deadline?: { rules?: Claim[]; lateness?: Claim };
  channels: Channel[];
  payment?: {
    method: string;
    codice_ente?: string;
    codici_tributo?: string[];
    rateazione?: string;
    status?: Status; // of codice_ente, codici_tributo and rateazione
    source?: string;
    calculator_url?: string;
    schedule?: { label: string; due: string; source?: string; status?: Status }[];
    notes?: Claim[];
  };
  documents?: { name: string; required: boolean; notes?: string }[];
  forms?: { id: string; name: string; url?: string; source?: string; signature_required?: boolean; fields: { label: string }[] }[];
  steps: { do: string; who: string; human_only?: boolean }[];
  after?: string[];
  records?: { field: string; from: string }[];
  pitfalls?: Claim[];
  related?: string[];
  sources: Source[];
  verification: { level: string; date: string; by: string; method: string; notes?: string };
  run_log?: { date: string; note: string }[];
}

export interface SiteOptions {
  baseUrl: string; // absolute, no trailing slash
  repoUrl: string;
  built: Date;
  css: string;
  schema: string; // contract/procedure.schema.json, published as is
  fields: string; // contract/fields.json
}

export const SITE_NAME = "Pratiche Napoli";
const TAGLINE =
  "Le pratiche burocratiche di Napoli spiegate in modo chiaro: chi deve farle, entro quando, come, con quali documenti. Ogni informazione cita la sua fonte ufficiale.";

const LEVELS: Record<string, string> = {
  L0: "bozza, non ancora controllata",
  L1: "controllata sulle fonti ufficiali",
  L2: "confermata dall'ufficio",
  L3: "usata per una pratica vera, andata a buon fine",
};
const EVENTS: Record<string, string> = {
  open: "apertura di un'attività",
  change: "modifiche",
  move: "trasloco o trasferimento",
  hire: "assunzioni",
  renovate: "lavori",
  signage: "insegne",
  dehors: "dehors e suolo pubblico",
  food: "alimenti",
  events: "eventi",
  close: "chiusura",
  annual: "adempimenti annuali",
  inspection: "controlli",
  letter: "avvisi, cartelle e multe",
  home: "casa",
};
const AUDIENCE: Record<string, string> = { business: "imprese", resident: "cittadini" };
const CHANNELS: Record<string, string> = {
  portal: "Portale online",
  pec: "PEC",
  email: "Email",
  desk: "Sportello",
  post: "Posta",
  phone: "Telefono",
  app: "App",
};
const AUTH: Record<string, string> = { spid: "SPID", cie: "CIE", cns: "CNS", none: "senza credenziali" };
const RECEIPT: Record<string, string> = {
  legal: "ricevuta con valore legale",
  informal: "ricevuta senza valore legale",
  none: "nessuna ricevuta",
};
const PAYMENT: Record<string, string> = {
  f24: "Modello F24",
  pagopa: "pagoPA",
  bollettino: "Bollettino postale",
  "marca-da-bollo": "Marca da bollo",
  none: "Nessun pagamento",
};
const WHO: Record<string, string> = {
  owner: "Tu",
  facilitator: "Chi ti assiste",
  professional: "Un professionista",
  office: "L'ufficio",
  anyone: "Chiunque, anche chi ti aiuta",
};
const STATUS: Record<string, string> = { unverified: "da verificare", disputed: "fonti in contrasto" };

// --- Whole site ---

export function buildSite(procedures: Procedure[], opts: SiteOptions): Map<string, string> {
  // A path set twice would silently replace a page (an id like napoli/comune
  // is also an ente's folder), so that is an error.
  const files = new (class extends Map<string, string> {
    set(path: string, content: string) {
      if (this.has(path)) throw new Error(`two pages would be written at ${path}`);
      return super.set(path, content);
    }
  })();
  const byId = new Map(procedures.map((p) => [p.id, p]));
  const entes = groupByEnte(procedures);
  const updated = latest(procedures.map((p) => p.updated));
  const site = { opts, byId, updated };

  files.set("index.html", renderHome(entes, site));
  for (const e of entes) files.set(`${e.path}/index.html`, renderEnte(e, site));
  for (const p of procedures) {
    files.set(`${p.id}/index.html`, renderProcedure(p, entes.find((e) => e.path === folderOf(p.id))!, site));
    files.set(`${p.id}.json`, JSON.stringify(p, null, 2) + "\n");
  }
  files.set("procedures.json", renderIndexJson(procedures, entes, site));
  files.set("contract/procedure.schema.json", opts.schema);
  files.set("contract/fields.json", opts.fields);
  files.set("sitemap.xml", renderSitemap(procedures, entes, site));
  files.set("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${opts.baseUrl}/sitemap.xml\n`);
  files.set("llms.txt", renderLlmsTxt(entes, site));
  files.set("style.css", opts.css);
  files.set("404.html", render404(site));
  return files;
}

interface Site {
  opts: SiteOptions;
  byId: Map<string, Procedure>;
  updated: string; // the newest procedure's updated date
}

interface Ente {
  path: string; // the procedures' folder, e.g. napoli/comune
  name: string;
  procedures: Procedure[];
  updated: string;
}

// One group per folder (an ente's procedures share one), Naples' own offices
// first, then by how many procedures they have.
// The folder is named after its procedures' ente, so they must agree on it.
function groupByEnte(procedures: Procedure[]): Ente[] {
  const groups = new Map<string, Procedure[]>();
  for (const p of procedures) groups.set(folderOf(p.id), [...(groups.get(folderOf(p.id)) ?? []), p]);
  for (const [path, ps] of groups) {
    const names = new Set(ps.map((p) => p.ente.name));
    if (names.size > 1) throw new Error(`procedures in ${path} name different enti: ${[...names].join(" / ")}`);
  }
  return [...groups]
    .map(([path, ps]) => ({
      path,
      name: ps[0].ente.name,
      procedures: ps.sort((a, b) => a.title.localeCompare(b.title, "it")),
      updated: latest(ps.map((p) => p.updated)),
    }))
    .sort(
      (a, b) =>
        Number(b.path.startsWith("napoli/")) - Number(a.path.startsWith("napoli/")) ||
        b.procedures.length - a.procedures.length ||
        a.name.localeCompare(b.name, "it"),
    );
}

const folderOf = (id: string) => id.slice(0, id.lastIndexOf("/"));
const latest = (dates: string[]) => dates.reduce((a, b) => (b > a ? b : a), "");
// From a page at `dir/index.html` back to the site root.
const rootFrom = (dir: string) => (dir ? "../".repeat(dir.split("/").length) : "");

// --- Pages ---

interface PageMeta {
  dir: string; // "" for the home page
  root?: string; // link prefix back to the site root, when it isn't the relative one from dir
  title: string;
  description: string;
  updated: string;
  jsonLd: object;
  head?: string;
}

function page(meta: PageMeta, body: string, site: Site): string {
  const root = meta.root ?? rootFrom(meta.dir);
  const url = `${site.opts.baseUrl}/${meta.dir ? meta.dir + "/" : ""}`;
  const fullTitle = meta.dir ? `${meta.title} | ${SITE_NAME}` : `${SITE_NAME} – ${meta.title}`;
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(fullTitle)}</title>
<meta name="description" content="${esc(clip(meta.description, 200))}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${SITE_NAME}">
<meta property="og:locale" content="it_IT">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(clip(meta.description, 200))}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:updated_time" content="${meta.updated}">
${meta.head ?? ""}<link rel="stylesheet" href="${root}style.css">
<script type="application/ld+json">${jsonLdText(meta.jsonLd)}</script>
</head>
<body>
<header class="site"><a class="brand" href="${root || "./"}">${SITE_NAME}</a></header>
<main>
${body}
</main>
${footer(root, site)}
</body>
</html>
`;
}

function footer(root: string, site: Site): string {
  const repo = site.opts.repoUrl;
  return `<footer class="site">
<p><strong>${SITE_NAME} è un progetto indipendente</strong>: non è un sito del Comune di Napoli né di altri enti.
Le informazioni servono a capire e preparare una pratica, non sono consulenza legale: prima di agire controlla sempre la fonte ufficiale citata.</p>
<p>Libreria aggiornata il ${time(site.updated)}.
<a href="${root}procedures.json">Dati in JSON</a> · <a href="${root}llms.txt">llms.txt</a> · <a href="${esc(repo)}">Codice e contenuti su GitHub</a>.
Contenuti con licenza <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.it">CC BY-SA 4.0</a>.</p>
</footer>`;
}

function renderHome(entes: Ente[], site: Site): string {
  const count = entes.reduce((n, e) => n + e.procedures.length, 0);
  const sections = entes
    .map(
      (e) => `<section class="ente" data-ente>
<h2><a href="${e.path}/">${esc(e.name)}</a></h2>
${procedureList(e.procedures, "")}
</section>`,
    )
    .join("\n");
  const body = `<h1>${SITE_NAME}</h1>
<p class="lead">${esc(TAGLINE)}</p>
<p class="meta">${count} pratiche · libreria aggiornata il ${time(site.updated)}</p>
<label class="search">Cerca una pratica <input type="search" id="q" placeholder="es. TARI, insegna, partita IVA" autocomplete="off"></label>
<p id="none" class="meta" hidden>Nessuna pratica trovata.</p>
${sections}
<script>
// Hides the pratiche (and whole enti) that don't match the search box.
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g, "");
const q = document.getElementById("q");
q.addEventListener("input", () => {
  const words = norm(q.value).split(/\\s+/).filter(Boolean);
  let any = false;
  for (const section of document.querySelectorAll("[data-ente]")) {
    let shown = 0;
    for (const li of section.querySelectorAll("li")) {
      const hit = words.every((w) => norm(li.dataset.search).includes(w));
      li.hidden = !hit;
      if (hit) shown++;
    }
    section.hidden = shown === 0;
    any ||= shown > 0;
  }
  document.getElementById("none").hidden = any;
});
</script>`;
  return page(
    {
      dir: "",
      title: "le pratiche burocratiche di Napoli, chiare e verificate",
      description: TAGLINE,
      updated: site.updated,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: SITE_NAME,
        url: `${site.opts.baseUrl}/`,
        inLanguage: "it",
        description: TAGLINE,
        dateModified: site.updated,
      },
    },
    body,
    site,
  );
}

function renderEnte(e: Ente, site: Site): string {
  const description = `Le pratiche con ${e.name} spiegate passo per passo: scadenze, canali, documenti e moduli, con le fonti ufficiali.`;
  const body = `<nav class="crumbs"><a href="${rootFrom(e.path)}">Tutte le pratiche</a></nav>
<h1>${esc(e.name)}</h1>
<p class="meta">${e.procedures.length === 1 ? "1 pratica · aggiornata il" : `${e.procedures.length} pratiche · ultimo aggiornamento il`} ${time(e.updated)}</p>
${procedureList(e.procedures, rootFrom(e.path))}`;
  return page(
    {
      dir: e.path,
      title: `Pratiche con ${e.name}`,
      description,
      updated: e.updated,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "CollectionPage",
        name: `Pratiche con ${e.name}`,
        url: `${site.opts.baseUrl}/${e.path}/`,
        inLanguage: "it",
        dateModified: e.updated,
        about: { "@type": "GovernmentOrganization", name: e.name },
        breadcrumb: breadcrumbs(site, [[e.name, e.path]]),
      },
    },
    body,
    site,
  );
}

function procedureList(procedures: Procedure[], root: string): string {
  const items = procedures.map(
    (p) => `<li data-search="${esc(`${p.title} ${p.summary}`)}"><a href="${root}${p.id}/">${esc(p.title)}</a>
<p>${esc(p.summary)}</p>
<p class="meta">Aggiornata il ${time(p.updated)} · ${esc(levelText(p.verification.level))}</p></li>`,
  );
  return `<ul class="procedures">\n${items.join("\n")}\n</ul>`;
}

function renderProcedure(p: Procedure, ente: Ente, site: Site): string {
  const root = rootFrom(p.id);
  const cite = citer(p);
  const v = p.verification;
  const sections = [
    section("A chi serve", appliesTo(p, cite)),
    p.legal_basis?.length ? section("Norme", claimList(p.legal_basis, cite)) : "",
    p.deadline ? section("Scadenza", deadline(p.deadline, cite)) : "",
    section("Come presentarla", p.channels.map((c) => channel(c, cite)).join("\n")),
    p.payment ? section("Pagamento", payment(p.payment, cite)) : "",
    p.documents?.length ? section("Documenti", documents(p.documents)) : "",
    p.forms?.length ? section("Moduli", forms(p.forms, cite)) : "",
    section("Passaggi", steps(p.steps)),
    p.after?.length ? section("Dopo l'invio", list(p.after.map(esc))) : "",
    p.records?.length
      ? section(
          "Cosa conservare",
          list(p.records.map((r) => `<strong>${esc(humanField(r.field))}</strong>: ${esc(r.from)}`)),
        )
      : "",
    p.pitfalls?.length ? section("Attenzione", claimList(p.pitfalls, cite)) : "",
    p.related?.length
      ? section(
          "Pratiche collegate",
          list(p.related.map((id) => `<a href="${root}${id}/">${esc(site.byId.get(id)?.title ?? id)}</a>`)),
        )
      : "",
    p.run_log?.length
      ? section("Casi reali", list(p.run_log.map((r) => `${time(r.date)}: ${esc(r.note)}`)))
      : "",
    section("Fonti", sources(p.sources)),
    section(
      "Verifica",
      `<p>Livello ${esc(v.level)}: ${esc(levelText(v.level))}. Ultima verifica il ${time(v.date)} (${esc(v.by)}).</p>
<p>${esc(v.method)}</p>${v.notes ? `\n<p>${esc(v.notes)}</p>` : ""}
<p>Ogni affermazione indica se è verificata su una fonte ufficiale, <span class="badge">da verificare</span> o con <span class="badge">fonti in contrasto</span>.</p>`,
    ),
  ];
  const issue = `${site.opts.repoUrl}/issues/new?title=${encodeURIComponent(`Errore in ${p.id}`)}`;
  const body = `<nav class="crumbs"><a href="${root}">Tutte le pratiche</a> › <a href="${root}${ente.path}/">${esc(ente.name)}</a></nav>
<article>
<h1>${esc(p.title)}</h1>
<p class="lead">${esc(p.summary)}</p>
<p class="meta">Aggiornata il ${time(p.updated)} · verificata il ${time(v.date)}, ${esc(levelText(v.level))} · ${esc([p.ente.name, p.ente.office].filter(Boolean).join(", "))}</p>
${sections.filter(Boolean).join("\n")}
<p class="actions"><a href="${esc(issue)}">Segnala un errore</a> · <a href="${root}${p.id}.json">Questa pratica in JSON</a></p>
</article>`;
  const url = `${site.opts.baseUrl}/${p.id}/`;
  return page(
    {
      dir: p.id,
      title: p.title,
      description: p.summary,
      updated: p.updated,
      head: `<link rel="alternate" type="application/json" href="${root}${p.id}.json">\n`,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: p.title,
        description: p.summary,
        url,
        inLanguage: "it",
        dateModified: p.updated,
        lastReviewed: v.date,
        isPartOf: { "@type": "WebSite", name: SITE_NAME, url: `${site.opts.baseUrl}/` },
        breadcrumb: breadcrumbs(site, [
          [ente.name, ente.path],
          [p.title, p.id],
        ]),
        about: {
          "@type": "GovernmentService",
          name: p.title,
          description: p.summary,
          provider: { "@type": "GovernmentOrganization", name: p.ente.name },
          areaServed: p.id.startsWith("napoli/") ? { "@type": "City", name: "Napoli" } : { "@type": "Country", name: "Italia" },
        },
      },
    },
    body,
    site,
  );
}

function render404(site: Site): string {
  // Served from any path, so links here are absolute.
  return page(
    {
      dir: "",
      root: `${site.opts.baseUrl}/`,
      head: '<meta name="robots" content="noindex">\n',
      title: "pagina non trovata",
      description: TAGLINE,
      updated: site.updated,
      jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: "Pagina non trovata" },
    },
    `<h1>Pagina non trovata</h1>\n<p><a href="${esc(site.opts.baseUrl)}/">Vai a tutte le pratiche</a></p>`,
    site,
  );
}

function breadcrumbs(site: Site, trail: [string, string][]): object {
  return {
    "@type": "BreadcrumbList",
    itemListElement: [["Tutte le pratiche", ""], ...trail].map(([name, dir], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name,
      item: `${site.opts.baseUrl}/${dir ? dir + "/" : ""}`,
    })),
  };
}

// --- Procedure sections ---

type Cite = (sourceId?: string) => string;

// Sources are numbered in the order the procedure lists them.
function citer(p: Procedure): Cite {
  const n = new Map(p.sources.map((s, i) => [s.id, i + 1]));
  return (id) => (id && n.has(id) ? ` <a class="cite" href="#fonte-${esc(id)}">[${n.get(id)}]</a>` : "");
}

function section(title: string, body: string): string {
  return `<section>\n<h2>${esc(title)}</h2>\n${body}\n</section>`;
}

function list(items: string[], cls = ""): string {
  return `<ul${cls ? ` class="${cls}"` : ""}>\n${items.map((i) => `<li>${i}</li>`).join("\n")}\n</ul>`;
}

function claim(c: Claim, cite: Cite): string {
  const badge = STATUS[c.status] ? ` <span class="badge">${STATUS[c.status]}</span>` : "";
  return `${esc(c.text)}${badge}${cite(c.source)}`;
}

function claimList(claims: Claim[], cite: Cite): string {
  return list(claims.map((c) => claim(c, cite)));
}

function appliesTo(p: Procedure, cite: Cite): string {
  const a = p.applies_to;
  const who = a.audience.map((x) => AUDIENCE[x] ?? x).join(" e ");
  const when = a.events.map((x) => EVENTS[x] ?? x).join(", ");
  return `<p class="meta">Per ${esc(who)} · ${esc(when)}${a.sectors?.length ? ` · ${esc(a.sectors.join(", "))}` : ""}</p>
${a.conditions?.length ? claimList(a.conditions, cite) : ""}`;
}

function deadline(d: NonNullable<Procedure["deadline"]>, cite: Cite): string {
  return [
    d.rules?.length ? claimList(d.rules, cite) : "",
    d.lateness ? `<h3>Se sei in ritardo</h3>\n<p>${claim(d.lateness, cite)}</p>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function channel(c: Channel, cite: Cite): string {
  const address = !c.address
    ? ""
    : c.type === "pec" || c.type === "email"
      ? `<a href="mailto:${esc(c.address)}">${esc(c.address)}</a>`
      : c.type === "phone"
        ? c.address
            .split(/\s*[/–—,;]\s*/)
            .map((n) => `<a href="tel:${esc(n.replace(/[^\d+]/g, ""))}">${esc(n)}</a>`)
            .join(" / ")
        : esc(c.address);
  const rows = [
    c.name ? esc(c.name) : "",
    address,
    c.url ? `<a href="${esc(c.url)}">${esc(c.url)}</a>` : "",
    c.auth?.length ? `Accesso con ${esc(c.auth.map((a) => AUTH[a] ?? a).join(", "))}` : "",
    c.hours ? `Orari: ${esc(c.hours)}` : "",
    c.booking ? `Prenotazione: ${esc(c.booking)}` : "",
    c.receipt ? `Dà una ${esc(RECEIPT[c.receipt] ?? c.receipt)}` : "",
    c.notes ? esc(c.notes) : "",
  ].filter(Boolean);
  return `<div class="card">
<h3>${esc(CHANNELS[c.type] ?? c.type)}${c.preferred ? ' <span class="badge good">consigliato</span>' : ""}${cite(c.source)}</h3>
${rows.map((r) => `<p>${r}</p>`).join("\n")}
</div>`;
}

function payment(pay: NonNullable<Procedure["payment"]>, cite: Cite): string {
  // The codes' status and source cover all three code lines.
  const mark = `${pay.status && STATUS[pay.status] ? ` <span class="badge">${STATUS[pay.status]}</span>` : ""}${cite(pay.source)}`;
  const facts = [
    `Come: ${esc(PAYMENT[pay.method] ?? pay.method)}`,
    pay.codice_ente ? `Codice ente: <code>${esc(pay.codice_ente)}</code>${mark}` : "",
    pay.codici_tributo?.length ? `Codici tributo: ${pay.codici_tributo.map((c) => `<code>${esc(c)}</code>`).join(", ")}${mark}` : "",
    pay.rateazione ? `Rateazione: <code>${esc(pay.rateazione)}</code>${mark}` : "",
    pay.calculator_url ? `Calcolo dell'importo: <a href="${esc(pay.calculator_url)}">simulatore ufficiale</a>` : "",
  ].filter(Boolean);
  const schedule = pay.schedule?.length
    ? `<table>
<thead><tr><th>Scadenza</th><th>Rata</th></tr></thead>
<tbody>
${pay.schedule
  .map(
    (s) =>
      `<tr><td>${time(s.due)}</td><td>${esc(s.label)}${s.status && STATUS[s.status] ? ` <span class="badge">${STATUS[s.status]}</span>` : ""}${cite(s.source)}</td></tr>`,
  )
  .join("\n")}
</tbody>
</table>`
    : "";
  return [list(facts), schedule, pay.notes?.length ? claimList(pay.notes, cite) : ""].filter(Boolean).join("\n");
}

function documents(docs: NonNullable<Procedure["documents"]>): string {
  return list(
    docs.map(
      (d) =>
        `${esc(d.name)} <span class="badge${d.required ? "" : " soft"}">${d.required ? "obbligatorio" : "facoltativo"}</span>${d.notes ? `<br><span class="note">${esc(d.notes)}</span>` : ""}`,
    ),
    "checklist",
  );
}

function forms(fs: NonNullable<Procedure["forms"]>, cite: Cite): string {
  return fs
    .map(
      (f) => `<div class="card">
<h3>${f.url ? `<a href="${esc(f.url)}">${esc(f.name)}</a>` : esc(f.name)}${cite(f.source)}</h3>
${f.signature_required ? "<p>Va firmato.</p>\n" : ""}${
        f.fields.length
          ? `<details><summary>Cosa chiede il modulo (${f.fields.length} campi)</summary>\n${list(f.fields.map((x) => esc(x.label)))}\n</details>`
          : ""
      }
</div>`,
    )
    .join("\n");
}

function steps(ss: Procedure["steps"]): string {
  const items = ss.map(
    (s) =>
      `<li>${esc(s.do)}<br><span class="note">${esc(WHO[s.who] ?? s.who)}${s.human_only ? ' · <span class="badge">deve farlo una persona</span>' : ""}</span></li>`,
  );
  return `<ol class="steps">\n${items.join("\n")}\n</ol>`;
}

function sources(ss: Source[]): string {
  const items = ss.map((s, i) => {
    const dates = [`consultata il ${time(s.retrieved)}`, s.page_updated ? `pagina aggiornata il ${time(s.page_updated)}` : ""]
      .filter(Boolean)
      .join(", ");
    return `<li id="fonte-${esc(s.id)}">[${i + 1}] ${s.url ? `<a href="${esc(s.url)}">${esc(s.label)}</a>` : esc(s.label)}
<br><span class="note">${s.official ? "Fonte ufficiale" : "Fonte non ufficiale"}, ${dates}.${s.notes ? ` ${esc(s.notes)}` : ""}</span></li>`;
  });
  return `<ol class="sources">\n${items.join("\n")}\n</ol>`;
}

// --- Machine-readable files ---

function renderIndexJson(procedures: Procedure[], entes: Ente[], site: Site): string {
  const base = site.opts.baseUrl;
  return (
    JSON.stringify(
      {
        name: SITE_NAME,
        description: TAGLINE,
        updated: site.updated,
        built: site.opts.built.toISOString(),
        count: procedures.length,
        schema: `${base}/contract/procedure.schema.json`,
        fields: `${base}/contract/fields.json`,
        license: { content: "CC BY-SA 4.0", code: "MIT" },
        procedures: entes.flatMap((e) =>
          e.procedures.map((p) => ({
            id: p.id,
            title: p.title,
            summary: p.summary,
            ente: p.ente.name,
            audience: p.applies_to.audience,
            events: p.applies_to.events,
            updated: p.updated,
            verification: { level: p.verification.level, date: p.verification.date },
            url: `${base}/${p.id}/`,
            json: `${base}/${p.id}.json`,
          })),
        ),
      },
      null,
      2,
    ) + "\n"
  );
}

function renderSitemap(procedures: Procedure[], entes: Ente[], site: Site): string {
  const base = site.opts.baseUrl;
  const urls: [string, string][] = [
    [`${base}/`, site.updated],
    ...entes.map((e): [string, string] => [`${base}/${e.path}/`, e.updated]),
    ...procedures.map((p): [string, string] => [`${base}/${p.id}/`, p.updated]),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([loc, lastmod]) => `<url><loc>${esc(loc)}</loc><lastmod>${lastmod}</lastmod></url>`).join("\n")}
</urlset>
`;
}

// https://llmstxt.org: a Markdown map of the site for language models.
function renderLlmsTxt(entes: Ente[], site: Site): string {
  const base = site.opts.baseUrl;
  const lines = [
    `# ${SITE_NAME}`,
    "",
    `> ${TAGLINE}`,
    "",
    "Each procedure has a page and the same content as JSON (add .json to the page path, without the trailing slash).",
    "Every claim carries a status (verified against an official source, unverified, or disputed when sources disagree) and cites its source.",
    `Procedures have a verification level (L0 draft, L1 desk-checked, L2 confirmed by the office, L3 used in a real filing) and an \`updated\` date. Library last updated ${site.updated}.`,
    "This is an independent project, not a site of the Comune di Napoli or any other ente, and not legal advice.",
    "",
    "## Data",
    "",
    `- [Index of all procedures](${base}/procedures.json): id, title, summary, ente, updated date, verification and URLs`,
    `- [Procedure schema](${base}/contract/procedure.schema.json): JSON Schema of each procedure file`,
    `- [Field registry](${base}/contract/fields.json): the field IDs form fields map to`,
  ];
  for (const e of entes) {
    lines.push("", `## ${e.name}`, "");
    for (const p of e.procedures) {
      lines.push(`- [${p.title}](${base}/${p.id}/): ${p.summary} Updated ${p.updated}, level ${p.verification.level}. JSON: ${base}/${p.id}.json`);
    }
  }
  return lines.join("\n") + "\n";
}

// --- Helpers ---

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Inside <script>, "</script>" or "<!--" in a string would end or upset the
// block; escaping "<" keeps the JSON identical once parsed.
function jsonLdText(data: object): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

const DATE = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// "2026-10-25" → <time datetime="2026-10-25">25 ottobre 2026</time>
export function time(date: string): string {
  return `<time datetime="${esc(date)}">${DATE.format(new Date(`${date}T00:00:00Z`))}</time>`;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[,;:.]$/, "") + "…";
}

function levelText(level: string): string {
  return LEVELS[level] ?? level;
}

// tari.codice_contribuente → "codice contribuente"
function humanField(id: string): string {
  return id.slice(id.indexOf(".") + 1).replace(/_/g, " ");
}
