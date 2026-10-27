// Renders the library as a static site: one page and one JSON file per
// procedure, a page per ente, the home page, and the files that let search
// engines and AI assistants find and read it (sitemap, robots, llms.txt and a
// JSON index). Every page shows when its content was last updated, and the
// same dates go into the sitemap, the structured data and the JSON.
//
// Rendering is pure: buildSite returns path → content, the CLI writes it.
// Links between pages are relative, so the site works under any path; only
// canonical URLs, the sitemap and the JSON index use the base URL.

import type { Reported } from "./reported.ts";

// Procedures are validated before they get here; this is the subset rendered.
type Status = "verified" | "unverified" | "disputed";
interface Claim {
  text: string;
  status: Status;
  source?: string;
}
interface Channel {
  type: string;
  purpose: "procedure" | "info" | "payment" | "related";
  name?: string;
  url?: string;
  address?: string;
  auth?: string[];
  hours?: string;
  booking?: string;
  receipt?: string;
  preferred?: boolean;
  office?: { list: string; from: string };
  notes?: string;
  source?: string;
}
type Signing = { channel: string; ways: string[]; id_copy: string; status: Status; notes?: string };
// offices/<list>.json (contract/offices.schema.json).
export interface Offices {
  field: string;
  name: string;
  serves: string;
  offices: Record<string, { name: string; address: string; hours?: string; phone?: string; email?: string; pec?: string; notes?: string; source: string }>;
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
  headline?: string;
  aka?: string[];
  updated: string;
  summary: string;
  ente: { name: string; office?: string };
  applies_to: { events: string[]; audience: string[]; sectors?: string[]; conditions?: Claim[] };
  legal_basis?: Claim[];
  deadline?: { summary?: Claim; rules?: Claim[]; lateness?: Claim };
  cost?: Claim;
  duration?: Claim;
  appointment?: Claim;
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
  forms?: {
    id: string;
    name: string;
    url?: string;
    source?: string;
    signature_required?: boolean;
    signing?: Signing[];
    fields: { label: string }[];
  }[];
  steps: { do: string; who: string; human_only?: boolean; channel?: string[] }[];
  after?: string[];
  records?: { field: string; from: string }[];
  pitfalls?: Claim[];
  related?: string[];
  sources: Source[];
  verification: { level: string; date: string; by: string; method: string; notes?: string };
  run_log?: { date: string; note: string }[];
  reported?: Reported;
}

// A situation only points at procedures (contract/situation.schema.json).
export interface Situation {
  id: string;
  headline: string;
  aka?: string[];
  updated: string;
  intro: string;
  steps: { procedure: string; when: string }[];
}

export interface SiteOptions {
  baseUrl: string; // absolute, no trailing slash
  repoUrl: string;
  built: Date;
  css: string;
  schema: string; // contract/procedure.schema.json, published as is
  fields: string; // contract/fields.json
  signing?: { channels: Record<string, { text: string }> }; // contract/signing.json, published as is
  offices?: Record<string, Offices>; // offices/<list>.json by list, published as is
  // The report form appears only with both: where reports go, and whom
  // people can write to about their data (the privacy page names it).
  reports?: { url: string; contact: string; script: string };
}

export const SITE_NAME = "Pratiche Napoli";
const TITLE_MAX = 65;
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
const AUTH: Record<string, string> = { spid: "SPID", cie: "CIE", cns: "CNS" };
// "con SPID, CIE", "con SPID o senza credenziali", "senza credenziali".
const access = (auth: string[]) => {
  const ways = auth.filter((a) => a !== "none").map((a) => AUTH[a] ?? a);
  if (!ways.length) return "senza credenziali";
  return `con ${ways.join(", ")}${auth.includes("none") ? " o senza credenziali" : ""}`;
};
// A route's heading, in "Scegli come farlo".
const ROUTE: Record<string, string> = {
  portal: "Online",
  pec: "Via PEC",
  email: "Per email",
  desk: "Allo sportello",
  post: "Per posta",
  phone: "Per telefono",
  app: "Con l'app",
};
const WAYS: Record<string, string> = {
  handwritten: "firma a mano",
  digital: "firma digitale",
  login: "accesso con SPID, CIE o CNS",
  none: "nessuna firma",
};
const ID_COPY: Record<string, string> = {
  required: "con la copia del documento d'identità",
  handwritten: "con la copia del documento d'identità se firmato a mano",
  not_needed: "senza copia del documento",
  unknown: "non è detto se serve la copia del documento",
};
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
// Channels that don't carry out the procedure say so on their card.
const PURPOSE: Record<string, string> = { info: "solo informazioni", payment: "per pagare", related: "servizio collegato" };

// --- Whole site ---

export function buildSite(procedures: Procedure[], opts: SiteOptions, situations: Situation[] = []): Map<string, string> {
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
  const updated = latest([...procedures, ...situations].map((x) => x.updated));
  const site: Site = { opts, byId, updated, situations };

  files.set("index.html", renderHome(entes, site));
  for (const e of entes) files.set(`${e.path}/index.html`, renderEnte(e, site));
  for (const p of procedures) {
    files.set(`${p.id}/index.html`, renderProcedure(p, entes.find((e) => e.path === folderOf(p.id))!, site));
    files.set(`${p.id}.json`, JSON.stringify(p, null, 2) + "\n");
  }
  files.set("procedures.json", renderIndexJson(procedures, entes, site));
  files.set("contract/procedure.schema.json", opts.schema);
  files.set("contract/fields.json", opts.fields);
  // What procedures point at: the law's signing rule per channel, the desks by area.
  if (opts.signing) files.set("contract/signing.json", JSON.stringify(opts.signing, null, 2) + "\n");
  for (const [list, o] of Object.entries(opts.offices ?? {})) files.set(`offices/${list}.json`, JSON.stringify(o, null, 2) + "\n");
  files.set("sitemap.xml", renderSitemap(procedures, entes, site));
  files.set("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${opts.baseUrl}/sitemap.xml\n`);
  files.set("llms.txt", renderLlmsTxt(entes, site));
  files.set("style.css", opts.css);
  files.set("404.html", render404(site));
  if (situations.length) {
    files.set("situazioni/index.html", renderSituations(site));
    for (const s of situations) files.set(`situazioni/${s.id}/index.html`, renderSituation(s, site));
  }
  files.set("come-lavoriamo/index.html", renderAbout(site));
  files.set("aggiornamenti/index.html", renderUpdates(procedures, site));
  files.set("privacy/index.html", renderPrivacy(site));
  files.set("grazie/index.html", renderThanks(site));
  if (opts.reports) files.set("report.js", opts.reports.script);
  return files;
}

interface Site {
  opts: SiteOptions;
  byId: Map<string, Procedure>;
  updated: string; // the newest updated date of any procedure or situation
  situations: Situation[];
}

interface Ente {
  path: string; // the procedures' folder, e.g. napoli/comune
  name: string;
  procedures: Procedure[];
  updated: string;
}

// One group per folder (an ente's procedures share one), Naples' own offices
// first, then by how many procedures they have.
// The folder is named after its procedures' ente, so they must agree on it,
// and an ente has one folder: two would be two sections with one name.
function groupByEnte(procedures: Procedure[]): Ente[] {
  const groups = new Map<string, Procedure[]>();
  for (const p of procedures) groups.set(folderOf(p.id), [...(groups.get(folderOf(p.id)) ?? []), p]);
  const folders = new Map<string, string>();
  for (const [path, ps] of groups) {
    const names = new Set(ps.map((p) => p.ente.name));
    if (names.size > 1) throw new Error(`procedures in ${path} name different enti: ${[...names].join(" / ")}`);
    const other = folders.get(ps[0].ente.name);
    if (other) throw new Error(`${other} and ${path} are both ${ps[0].ente.name}: one folder per ente`);
    folders.set(ps[0].ente.name, path);
  }
  return [...groups]
    .map(([path, ps]) => ({
      path,
      name: ps[0].ente.name,
      procedures: ps.sort((a, b) => heading(a).localeCompare(heading(b), "it")),
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
// What a page is called: the searcher's words when there are some, else the official name.
const heading = (p: Procedure) => p.headline ?? p.title;
const latest = (dates: string[]) => dates.reduce((a, b) => (b > a ? b : a), "");
// A situation's page changes when it or any of its procedures does.
const situationUpdated = (s: Situation, site: Site) =>
  latest([s.updated, ...s.steps.map((x) => site.byId.get(x.procedure)?.updated ?? "")]);
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
  // Search results cut titles at about 60 characters: the site's name goes
  // after a page's own only when both fit, so the headline is never cut for it.
  const fullTitle = !meta.dir
    ? `${SITE_NAME} – ${meta.title}`
    : meta.title.length + SITE_NAME.length + 3 <= TITLE_MAX
      ? `${meta.title} | ${SITE_NAME}`
      : meta.title;
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
<a href="${root}come-lavoriamo/">Come lavoriamo</a> · <a href="${root}aggiornamenti/">Aggiornamenti</a> · <a href="${root}privacy/">Privacy</a> · <a href="${root}procedures.json">Dati in JSON</a> · <a href="${root}llms.txt">llms.txt</a> · <a href="${esc(repo)}">Codice e contenuti su GitHub</a>.
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
${
  site.situations.length
    ? `<section class="ente" data-ente>
<h2><a href="situazioni/">Per situazione</a></h2>
${situationList(site.situations, "")}
</section>\n`
    : ""
}${sections}
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
    (p) => `<li data-search="${esc([...new Set([heading(p), p.title, ...(p.aka ?? [])]), p.summary].join(" "))}"><a href="${root}${p.id}/">${esc(heading(p))}</a>
<p>${esc(p.summary)}</p>
<p class="meta">Aggiornata il ${time(p.updated)} · ${esc(levelText(p.verification.level))}</p></li>`,
  );
  return `<ul class="procedures">\n${items.join("\n")}\n</ul>`;
}

function renderProcedure(p: Procedure, ente: Ente, site: Site): string {
  const root = rootFrom(p.id);
  const cite = citer(p);
  const v = p.verification;
  const reports = site.opts.reports;
  // Every section shown, for the form's "which part was wrong" choice.
  const shown: [string, string][] = [["in-breve", "In breve"]];
  const sec = (id: string, title: string, body: string) => {
    shown.push([id, title]);
    return section(id, title, body, !!reports);
  };
  // Headings are the questions people ask; ids stay fixed for links.
  const sections = [
    sec("chi", "Chi deve farla?", appliesTo(p, cite)),
    p.legal_basis?.length ? sec("norme", "Su quali norme si basa?", claimList(p.legal_basis, cite)) : "",
    p.deadline ? sec("scadenza", "Entro quando va fatta?", deadline(p.deadline, cite)) : "",
    sec(
      "come",
      "Come si presenta?",
      [...p.channels.filter((c) => c.purpose === "procedure"), ...p.channels.filter((c) => c.purpose !== "procedure")]
        .map((c) => channel(c, cite, site.opts.offices))
        .join("\n"),
    ),
    p.payment ? sec("pagamento", "Come si paga?", payment(p.payment, cite)) : "",
    p.documents?.length ? sec("documenti", "Quali documenti servono?", documents(p.documents)) : "",
    p.forms?.length ? sec("moduli", "Quali moduli servono?", forms(p.forms, cite)) : "",
    sec("passaggi", "Quali sono i passaggi?", steps(p, site.opts)),
    p.reported ? sec("esperienze", "Com'è andata ad altri", experiences(p.reported, p)) : "",
    p.after?.length ? sec("dopo", "Cosa succede dopo l'invio?", list(p.after.map(esc))) : "",
    p.records?.length
      ? sec(
          "conservare",
          "Cosa conservare",
          list(p.records.map((r) => `<strong>${esc(humanField(r.field))}</strong>: ${esc(r.from)}`)),
        )
      : "",
    p.pitfalls?.length ? sec("attenzione", "A cosa fare attenzione?", claimList(p.pitfalls, cite)) : "",
    p.related?.length
      ? sec(
          "collegate",
          "Pratiche collegate",
          list(p.related.map((id) => `<a href="${root}${id}/">${esc(site.byId.has(id) ? heading(site.byId.get(id)!) : id)}</a>`)),
        )
      : "",
    p.run_log?.length
      ? sec("casi", "Casi reali", list(p.run_log.map((r) => `${time(r.date)}: ${esc(r.note)}`)))
      : "",
    sec("fonti", "Fonti", sources(p.sources)),
    sec(
      "verifica",
      "Verifica",
      `<p>Livello ${esc(v.level)}: ${esc(levelText(v.level))}. Ultima verifica il ${time(v.date)} (${esc(v.by)}).</p>
<p>${esc(v.method)}</p>${v.notes ? `\n<p>${esc(v.notes)}</p>` : ""}
<p>Ogni affermazione indica se è verificata su una fonte ufficiale, <span class="badge">da verificare</span> o con <span class="badge">fonti in contrasto</span>. <a href="${root}come-lavoriamo/">Come lavoriamo</a></p>`,
    ),
  ];
  const body = `<nav class="crumbs"><a href="${root}">Tutte le pratiche</a> › <a href="${root}${ente.path}/">${esc(ente.name)}</a></nav>
<article>
<h1>${esc(heading(p))}</h1>
${p.headline ? `<p class="official">${esc(p.title)}</p>\n` : ""}${p.aka?.length ? `<p class="meta">Conosciuta anche come: ${esc(p.aka.join(", "))}</p>\n` : ""}<p class="lead">${esc(p.summary)}</p>
<p class="meta">Aggiornata il ${time(p.updated)} · verificata il ${time(v.date)}, ${esc(levelText(v.level))} · ${esc([p.ente.name, p.ente.office].filter(Boolean).join(", "))}</p>
${partOf(p, site)}${reports ? '<p class="actions"><a href="#racconta">Hai fatto questa pratica? Racconta com\'è andata</a></p>\n' : ""}${quickAnswer(p, cite, !!reports)}
${sections.filter(Boolean).join("\n")}
${reports ? reportForm(p, shown, site) : ""}
<p class="actions">${
    reports
      ? ""
      : `<a href="${esc(`${site.opts.repoUrl}/issues/new?title=${encodeURIComponent(`Errore in ${p.id}`)}`)}">Segnala un errore su GitHub</a> (la segnalazione è pubblica: non scrivere dati personali) · `
  }<a href="${root}${p.id}.json">Questa pratica in JSON</a></p>
</article>`;
  const url = `${site.opts.baseUrl}/${p.id}/`;
  return page(
    {
      dir: p.id,
      title: heading(p),
      description: describe(p),
      updated: p.updated,
      head: `<link rel="alternate" type="application/json" href="${root}${p.id}.json">\n${reports ? `<script src="${root}report.js" defer></script>\n` : ""}`,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: heading(p),
        description: p.summary,
        url,
        inLanguage: "it",
        dateModified: p.updated,
        lastReviewed: v.date,
        isPartOf: { "@type": "WebSite", name: SITE_NAME, url: `${site.opts.baseUrl}/` },
        breadcrumb: breadcrumbs(site, [
          [ente.name, ente.path],
          [heading(p), p.id],
        ]),
        about: {
          "@type": "GovernmentService",
          name: p.title,
          ...(p.headline || p.aka?.length ? { alternateName: [...(p.headline ? [p.headline] : []), ...(p.aka ?? [])] } : {}),
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

// With `flag`, a link under the heading opens the report form preset to this
// section (report.js presets it). It stays out of the <h2>, whose text is the
// question people search for, and points at #racconta so the page doesn't reload.
function section(id: string, title: string, body: string, flag = false): string {
  return `<section id="${id}">\n<h2>${esc(title)}</h2>\n${flag ? flagLink(id) : ""}${body}\n</section>`;
}

const flagLink = (id: string) =>
  `<p class="flag"><a href="#racconta" data-section="${id}">Segnala un errore in questa parte</a></p>\n`;

const ONLINE = new Set(["portal", "pec", "email", "app"]);

// The "In breve" box: the answers people look for first, each with its
// status and source, linking down to the section that explains it.
function quickAnswer(p: Procedure, cite: Cite, flag: boolean): string {
  // Only channels that carry out the procedure answer "online?": many PECs and
  // emails are for questions, and filings sent there aren't processed.
  const ways = p.channels.filter((c) => c.purpose === "procedure");
  const online = ways.filter((c) => ONLINE.has(c.type));
  const channelName = (c: Channel) => `${CHANNELS[c.type] ?? c.type}${c.name ? ` (${c.name})` : ""}${c.auth?.length ? `, ${access(c.auth)}` : ""}`;
  const required = (p.documents ?? []).filter((d) => d.required).length;
  // Steps by a professional or the office aren't the reader's to do.
  const yours = p.steps.filter((s) => s.human_only && s.who === "owner");
  const due = deadlineSummary(p);
  const rows: [string, string][] = [
    ...(due ? [["Scadenza", `${claim(due, cite)} <a href="#scadenza">Dettagli</a>`] as [string, string]] : []),
    ...(p.cost ? [["Costo", claim(p.cost, cite)] as [string, string]] : []),
    ...(p.duration ? [["Tempi", claim(p.duration, cite)] as [string, string]] : []),
    ...(answerTimes(p.reported)
      ? [["Tempi reali", `${esc(answerTimes(p.reported)!)}, secondo chi l'ha fatta. <a href="#esperienze">Racconti</a>`] as [string, string]]
      : []),
    [
      "Si può fare online?",
      `${
        online.length
          ? `Sì: ${esc(online.map(channelName).join("; "))}.`
          : `No: ${esc([...new Set(ways.map((c) => CHANNELS[c.type] ?? c.type))].join(", ").toLowerCase())}.`
      } <a href="#come">Dettagli</a>`,
    ],
    ...(p.appointment ? [["Appuntamento", claim(p.appointment, cite)] as [string, string]] : []),
    ...(required ? [["Documenti", `${required} ${required === 1 ? "obbligatorio" : "obbligatori"}. <a href="#documenti">Elenco</a>`] as [string, string]] : []),
    ...(yours.length
      ? [["Cosa devi fare tu", `${esc(yours.map((s) => s.do.replace(/\.$/, "")).join("; "))}. <a href="#passaggi">Passaggi</a>`] as [string, string]]
      : []),
  ];
  return `<section id="in-breve" class="quick">
<h2>In breve</h2>
${flag ? flagLink("in-breve") : ""}
<dl>
${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("\n")}
</dl>
</section>`;
}

// The deadline for "In breve": the summary, or the only rule there is.
function deadlineSummary(p: Procedure): Claim | undefined {
  const rules = p.deadline?.rules ?? [];
  return p.deadline?.summary ?? (rules.length === 1 ? rules[0] : undefined);
}

// The meta description: the summary's first sentence, then the quick facts.
// Search snippets drop the page's badges, so only verified facts go in.
function describe(p: Procedure): string {
  const first = firstSentence(p.summary);
  // A fact the sentence already gives ("90 giorni") isn't repeated.
  const said = (fact: string) => {
    const key = fact.match(/\d+(?:[.,]\d+)?\s*(?:giorni|mesi|anni|euro|€)/i)?.[0];
    return !!key && first.toLowerCase().includes(key.toLowerCase());
  };
  const facts = [deadlineSummary(p), p.cost, p.duration]
    .filter((c): c is Claim => c?.status === "verified")
    .map((c) => c.text)
    .filter((t) => !said(t));
  // The facts that fit whole, after the sentence (shortened if that makes
  // room): a fact cut in the middle would say less than none.
  for (const lead of [first, clip(first, SHORT_LEAD)]) {
    const fitting: string[] = [];
    for (const fact of facts) if ([lead, ...fitting, fact].join(" ").length <= DESCRIPTION_MAX) fitting.push(fact);
    if (fitting.length) return [lead, ...fitting].join(" ");
  }
  return first;
}

const DESCRIPTION_MAX = 200;
const SHORT_LEAD = 120;

// Abbreviations a sentence doesn't end at: "con il Mod. 1", "art. 35", "D.P.R. 151/2011".
const ABBREVIATION =
  /(^|[\s(])(mod|modd|art|artt|n|nn|c|cc|co|lett|all|es|cfr|pag|pagg|ss|sez|tab|reg|rif|tel|dott|sig|sigg|prof|ing|arch|geom|avv|spett|vd|v|p|pp|l|dl|dlgs|dpr|dm|dgr|dcc|dgc|dd|rd|lr|gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic|[a-z]\.[a-z.]*)$/i;

// Up to the first full stop that ends a sentence (with any closing quote or
// bracket): one followed by a capital, a digit or an opening quote (or by
// nothing), after a word that isn't an abbreviation.
export function firstSentence(text: string): string {
  for (const m of text.matchAll(/[.!?]["»”')\]]*(?=\s+(\S)|$)/g)) {
    const next = m[1];
    if (next !== undefined && !/[\p{Lu}\d"«“(]/u.test(next)) continue;
    if (m[0].startsWith(".") && ABBREVIATION.test(text.slice(0, m.index))) continue;
    return text.slice(0, m.index + m[0].length);
  }
  return text;
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

function channel(c: Channel, cite: Cite, offices?: Record<string, Offices>): string {
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
    c.auth?.length ? `Accesso ${esc(access(c.auth))}` : "",
    c.hours ? `Orari: ${esc(c.hours)}` : "",
    c.booking ? `Prenotazione: ${esc(c.booking)}` : "",
    c.receipt ? `Dà una ${esc(RECEIPT[c.receipt] ?? c.receipt)}` : "",
    c.notes ? esc(c.notes) : "",
  ].filter(Boolean);
  return `<div class="card">
<h3>${esc(CHANNELS[c.type] ?? c.type)}${c.preferred ? ' <span class="badge good">consigliato</span>' : ""}${PURPOSE[c.purpose] ? ` <span class="badge soft">${PURPOSE[c.purpose]}</span>` : ""}${cite(c.source)}</h3>
${rows.map((r) => `<p>${r}</p>`).join("\n")}${c.office ? officeTable(c.office, offices) : ""}
</div>`;
}

// The desks of a channel picked by the person's municipalità or distretto.
function officeTable(office: { list: string }, offices?: Record<string, Offices>): string {
  const o = offices?.[office.list];
  if (!o) return "";
  const kind = o.field;
  const rows = Object.entries(o.offices).map(
    ([k, x]) =>
      `<tr><td>${esc(k)}</td><td>${esc(x.name)}<br>${esc(x.address)}${x.notes ? `<br><span class="note">${esc(x.notes)}</span>` : ""}</td><td>${esc(x.hours ?? "")}${[x.phone, x.email, x.pec && `PEC ${x.pec}`].map((c) => (c ? `<br>${esc(c)}` : "")).join("")}</td></tr>`,
  );
  return `
<p>${esc(o.name)}: quello ${kind === "municipalita" ? "della tua municipalità" : "del tuo distretto sanitario"}. ${esc(o.serves)}.</p>
<table>
<thead><tr><th>${kind === "municipalita" ? "Municipalità" : "Distretto"}</th><th>Indirizzo</th><th>Orari e contatti</th></tr></thead>
<tbody>
${rows.join("\n")}
</tbody>
</table>`;
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

// The steps in order. A run of steps that belong to some routes only becomes
// one step, "Scegli come farlo", with a heading per route: its steps,
// how to sign there and what it gives back (GOV.UK's "or" step). A run on one
// route only stays as steps, labelled with it.
function steps(p: Procedure, opts: SiteOptions): string {
  const item = (s: Procedure["steps"][number], label = "") =>
    `<li>${label}${esc(s.do)}<br><span class="note">${esc(WHO[s.who] ?? s.who)}${s.human_only ? ' · <span class="badge">deve farlo una persona</span>' : ""}</span></li>`;
  const facts = (c: Channel) => {
    const signing = routeSigning(c.type, p, opts);
    const out = [signing ? `Firma: ${esc(signing)}` : "", c.receipt ? `Ricevi una ${esc(RECEIPT[c.receipt] ?? c.receipt)}.` : ""];
    return out.some(Boolean) ? `\n<p class="note">${out.filter(Boolean).join(" ")}</p>` : "";
  };
  // Each route once, the preferred first.
  const routes = p.channels.filter((c, k, all) => c.purpose === "procedure" && all.findIndex((x) => x.purpose === "procedure" && x.type === c.type) === k);
  const ordered = [...routes.filter((c) => c.preferred), ...routes.filter((c) => !c.preferred)];
  const items: string[] = [];
  for (let i = 0; i < p.steps.length; ) {
    if (!p.steps[i].channel) {
      items.push(item(p.steps[i++]));
      continue;
    }
    const run: Procedure["steps"] = [];
    while (i < p.steps.length && p.steps[i].channel) run.push(p.steps[i++]);
    const on = ordered.filter((c) => run.some((s) => s.channel!.includes(c.type)));
    if (on.length === 1) {
      const label = `<span class="badge soft">${esc(ROUTE[on[0].type] ?? on[0].type)}</span> `;
      const lis = run.map((s) => item(s, label));
      lis[lis.length - 1] = lis[lis.length - 1].replace(/<\/li>$/, `${facts(on[0])}</li>`);
      items.push(...lis);
      continue;
    }
    const parts = on.map(
      (c) => `<h3>${esc(ROUTE[c.type] ?? c.type)}${c.preferred ? ' <span class="badge good">consigliato</span>' : ""}</h3>
<ol>
${run
  .filter((s) => s.channel!.includes(c.type))
  .map((s) => item(s))
  .join("\n")}
</ol>${facts(c)}`,
    );
    items.push(`<li>Scegli come farlo:\n${parts.join("\n")}\n</li>`);
  }
  return `<ol class="steps">\n${items.join("\n")}\n</ol>`;
}

// How the procedure's signed forms are signed on a route: a form's own rule
// where it has one, else the law's (contract/signing.json).
function routeSigning(type: string, p: Procedure, opts: SiteOptions): string {
  const texts = (p.forms ?? [])
    .filter((f) => f.signature_required)
    .map((f) => {
      const own = f.signing?.find((x) => x.channel === type);
      if (!own) return opts.signing?.channels[type]?.text ?? "";
      const how = `${own.ways.map((w) => WAYS[w] ?? w).join(" o ")}, ${ID_COPY[own.id_copy] ?? own.id_copy}.`;
      return `${how.charAt(0).toUpperCase()}${how.slice(1)}${own.notes ? ` ${own.notes}` : ""}`;
    });
  return [...new Set(texts.filter(Boolean))].join(" ");
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
        signing: `${base}/contract/signing.json`,
        offices: Object.keys(site.opts.offices ?? {}).map((f) => `${base}/offices/${f}.json`),
        license: { content: "CC BY-SA 4.0", code: "MIT" },
        situations: site.situations.map((s) => ({
          id: s.id,
          headline: s.headline,
          updated: situationUpdated(s, site),
          url: `${base}/situazioni/${s.id}/`,
          procedures: s.steps.map((x) => x.procedure),
        })),
        procedures: entes.flatMap((e) =>
          e.procedures.map((p) => ({
            id: p.id,
            title: p.title,
            headline: heading(p),
            aka: p.aka ?? [],
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
    ...(site.situations.length ? [[`${base}/situazioni/`, latest(site.situations.map((s) => situationUpdated(s, site)))] as [string, string]] : []),
    ...site.situations.map((s): [string, string] => [`${base}/situazioni/${s.id}/`, situationUpdated(s, site)]),
    [`${base}/aggiornamenti/`, site.updated],
    // These change with the code, not the library: a lastmod moving with every
    // procedure would be wrong, and search engines stop trusting a sitemap's dates.
    [`${base}/come-lavoriamo/`, ""],
    [`${base}/privacy/`, ""],
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([loc, lastmod]) => `<url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("\n")}
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
    `- [Signing by channel](${base}/contract/signing.json): how PEC, email, post and desk take a signature by law, unless a form's own \`signing\` says otherwise`,
    ...Object.entries(site.opts.offices ?? {}).map(
      ([list, o]) => `- [${o.name}](${base}/offices/${list}.json): ${o.serves}; the desk for each ${o.field}, as a desk channel's \`office\` names it`,
    ),
  ];
  if (site.situations.length) {
    lines.push("", "## Situations", "", "Each lists the procedures a situation involves; facts and sources are on the procedures' pages.", "");
    for (const s of site.situations) {
      lines.push(`- [${s.headline}](${base}/situazioni/${s.id}/): ${s.intro} Procedures: ${s.steps.map((x) => x.procedure).join(", ")}.`);
    }
  }
  for (const e of entes) {
    lines.push("", `## ${e.name}`, "");
    for (const p of e.procedures) {
      const official = p.headline ? ` Official name: ${p.title}.` : "";
      lines.push(`- [${heading(p)}](${base}/${p.id}/): ${p.summary}${official} Updated ${p.updated}, level ${p.verification.level}. JSON: ${base}/${p.id}.json`);
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

// --- Reports ---

const OUTCOMES: [string, string][] = [
  ["completata", "È andata a buon fine"],
  ["chiesto_altro", "Mi hanno chiesto altro"],
  ["respinta", "È stata respinta"],
  ["in_attesa", "Sto ancora aspettando"],
  ["rinunciato", "Ho rinunciato"],
];
const VERDICTS: [string, string][] = [
  ["sbagliata", "era sbagliata"],
  ["superata", "non è più vera"],
  ["confermata", "era giusta"],
];

// The months a report can be about, newest first: the last 12, the ones the
// figures use (the backend refuses older ones).
function recentMonths(built: Date): [string, string][] {
  const fmt = new Intl.DateTimeFormat("it-IT", { month: "long", year: "numeric", timeZone: "UTC" });
  return Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(built.getUTCFullYear(), built.getUTCMonth() - i, 1));
    return [d.toISOString().slice(0, 7), fmt.format(d)] as [string, string];
  });
}

// The "how did it go" form. It posts as a plain form (the backend answers with
// a redirect to /grazie/), and report.js sends it as JSON when JavaScript runs.
// Its fields come from the procedure: channels, offices, documents, sections.
function reportForm(p: Procedure, shown: [string, string][], site: Site): string {
  const reports = site.opts.reports!;
  const root = rootFrom(p.id);
  const options = (pairs: [string, string][], blank?: string) =>
    (blank !== undefined ? `<option value="">${esc(blank)}</option>` : "") +
    pairs.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
  const types = [...new Set([...p.channels.map((c) => c.type), ...Object.keys(CHANNELS)])];
  // Each office remembers its channel type, so picking one can preset "how".
  const offices = new Map<string, string>();
  for (const c of p.channels) {
    const name = (c.name ?? CHANNELS[c.type] ?? c.type).slice(0, 120);
    if (!offices.has(name)) offices.set(name, c.type);
  }
  const docs = (p.documents ?? []).slice(0, 50);
  const radio = (name: string, value: string, label: string, required = false) =>
    `<label class="choice"><input type="radio" name="${name}" value="${value}"${required ? " required" : ""}> ${esc(label)}</label>`;
  return `<section id="racconta" class="report">
<h2>Hai fatto questa pratica? Racconta com'è andata</h2>
<p>Ci aiuti a tenere questa pagina vera. Non pubblichiamo il tuo racconto: solo statistiche, quando sono almeno 3, e consigli riscritti da noi. <strong>Non scrivere nomi, codici fiscali, indirizzi o altri dati personali.</strong> <a href="${root}privacy/">Come usiamo i dati</a></p>
<form method="post" action="${esc(reports.url)}" data-report>
<input type="hidden" name="procedure" value="${esc(p.id)}">
<input type="hidden" name="source" value="web">
<div class="hp" aria-hidden="true"><label>Lascia vuoto <input type="text" name="website" tabindex="-1" autocomplete="off"></label></div>
<label>Quando l'hai fatta (o ci hai lavorato l'ultima volta)?
<select name="done" required>${options(recentMonths(site.opts.built), "Scegli il mese")}</select></label>
<label>Come l'hai presentata?
<select name="channel" required>${options(types.map((t) => [t, CHANNELS[t] ?? t]), "Scegli")}</select></label>
<label>A quale ufficio o portale?
<select name="office" required><option value="">Scegli</option>${[...offices]
    .map(([name, type]) => `<option value="${esc(name)}" data-type="${type}">${esc(name)}</option>`)
    .join("")}<option value="altro">Altro</option></select></label>
<fieldset><legend>Com'è finita?</legend>
${OUTCOMES.map(([v, l], i) => radio("outcome", v, l, i === 0)).join("\n")}
</fieldset>
<label>Dopo quanti giorni ti hanno risposto? <input type="number" name="days_to_answer" min="0" max="730" inputmode="numeric"></label>
<label>Se sei andato allo sportello, quanti minuti hai aspettato? <input type="number" name="desk_wait_minutes" min="0" max="600" inputmode="numeric"></label>
<label>Quanto hai pagato in tutto, in euro? (per esempio 16, 66,50 o 1.250) <input type="text" name="paid_eur" inputmode="decimal" pattern="[0-9]{1,3}(\\.[0-9]{3})+(,[0-9]{1,2})?|[0-9]+([.,][0-9]{1,2})?" title="Un importo come 16, 66,50 o 1.250"></label>
${
  docs.length
    ? `<fieldset><legend>Quali di questi documenti ti hanno chiesto?</legend>
${docs
  .map(
    (d, i) => `<fieldset class="doc"><legend>${esc(d.name)}</legend><input type="hidden" name="documents[${i}][name]" value="${esc(d.name)}">
${radio(`documents[${i}][asked]`, "si", "sì")} ${radio(`documents[${i}][asked]`, "no", "no")}</fieldset>`,
  )
  .join("\n")}
</fieldset>`
    : ""
}
<label>Ti hanno chiesto altri documenti? Quali? <textarea name="extra_documents" maxlength="300" rows="2"></textarea></label>
<fieldset><legend>Qualcosa su questa pagina era sbagliato o superato?</legend>
<label>Quale parte <select name="claim_feedback[0][section]">${options([...shown, ["pagina", "Tutta la pagina, o non so"]], "Nessuna")}</select></label>
<label>L'informazione <select name="claim_feedback[0][verdict]">${options(VERDICTS, "Scegli")}</select></label>
<label>Cosa hai trovato invece? <textarea name="claim_feedback[0][text]" maxlength="500" rows="2"></textarea></label>
</fieldset>
<label>Un consiglio per chi la fa dopo di te? <textarea name="note" maxlength="1000" rows="3"></textarea></label>
<label class="choice"><input type="checkbox" name="consent_contact"> Potete scrivermi per chiarimenti su questo racconto</label>
<label>La tua email (solo se hai spuntato la casella sopra) <input type="email" name="contact_email" maxlength="254" autocomplete="email"></label>
<p><button type="submit">Invia il racconto</button></p>
<p class="status" role="status" aria-live="polite"></p>
</form>
</section>`;
}

function renderPrivacy(site: Site): string {
  const contact = site.opts.reports?.contact;
  const body = `<h1>Privacy</h1>
<p>${SITE_NAME} non usa cookie né strumenti di tracciamento. Come per ogni sito, il servizio che lo ospita registra per motivi tecnici e di sicurezza l'indirizzo IP e le pagine richieste (log di accesso); non li usiamo per nient'altro.</p>
<h2>I racconti di chi ha fatto una pratica</h2>
<p>Se compili il modulo "Racconta com'è andata", riceviamo solo quello che scrivi: il mese, il canale e l'ufficio, com'è finita, tempi, importi, quali documenti ti hanno chiesto, le tue note e, se ne segnali, le correzioni alla pagina. Lo usiamo per un solo scopo: tenere aggiornate le pagine delle pratiche.</p>
<ul>
<li><strong>Cosa pubblichiamo</strong>: mai il tuo racconto così com'è. Solo statistiche in cui ogni numero viene da almeno 3 racconti (per esempio "risposta in circa 25 giorni via PEC, 7 racconti"): il valore tipico (la mediana, arrotondata, tranne quando è di pochi giorni), mai il più alto o il più basso, e consigli scritti da noi. Ogni versione pubblicata resta nella cronologia del progetto, e la regola dei 3 vale anche mettendo insieme le versioni: i racconti entrano almeno 3 alla volta, escono insieme a quelli con cui sono entrati, e ogni numero vale anche dentro ciascuno di questi gruppi. Per saperlo pubblichiamo anche un codice casuale per ogni racconto, diverso dal numero di ricevuta che ti diamo: dalla ricevuta non si arriva al codice.</li>
<li><strong>Cosa resta possibile</strong>: un gruppo di 3 protegge, ma non del tutto. Se un dato è uguale per tutti e 3 (per esempio tutti e 3 sono stati respinti), chi sa che il tuo racconto è in quel gruppo, perché sa quando l'hai mandato, sa anche com'è andata a te. E chi manda di proposito altri racconti insieme al tuo può risalire anche ai tuoi tempi o importi. Prima di accettarli controlliamo i racconti e scartiamo quelli che sembrano mandati dalla stessa persona: questo aiuta contro il secondo caso, non contro il primo.</li>
<li><strong>Dati personali</strong>: non ne chiediamo e ti chiediamo di non scriverne. Codici fiscali e IBAN scritti per errore, anche con un errore di battitura, vengono tolti automaticamente all'arrivo.</li>
<li><strong>Indirizzo IP</strong>: non lo salviamo con il racconto, e il servizio che lo riceve è impostato per non conservarlo nei suoi registri. Per limitare gli invii ripetuti teniamo un codice pseudonimo ricavato dall'indirizzo, valido un'ora e cancellato automaticamente, di norma entro un giorno.</li>
<li><strong>Email</strong>: la chiediamo solo se spunti la casella per essere ricontattato. È conservata separata dal racconto e cancellata dopo 12 mesi.</li>
<li><strong>Dove</strong>: su Google Firebase, in un database nell'Unione europea (Milano), accessibile solo a chi cura il progetto. Per calcolare le statistiche chi cura il progetto ne scarica sul proprio computer solo i campi che servono (né le note, né l'ufficio, né l'email), in un file che si usa entro un'ora e viene cancellato appena usato.</li>
<li><strong>Per quanto</strong>: ogni racconto viene cancellato automaticamente 12 mesi dopo il mese della pratica che racconta, quando esce comunque dalle statistiche, che usano solo quelli degli ultimi 12 mesi (può uscirne prima, insieme a quelli con cui è entrato). Per questo il modulo accetta solo pratiche degli ultimi 12 mesi. Le statistiche già pubblicate, con i codici casuali, restano nella cronologia pubblica del progetto.</li>
<li><strong>I tuoi diritti</strong>: dopo l'invio ricevi un codice del racconto. Con quel codice, o con l'email se l'hai lasciata, puoi chiederci in ogni momento di vederlo, correggerlo o cancellarlo.</li>
<li><strong>Base giuridica</strong>: il tuo consenso, che dai inviando il modulo (e spuntando la casella, per l'email). Puoi revocarlo quando vuoi.</li>
</ul>
<h2>Contatti</h2>
${
  contact
    ? `<p>Per qualunque richiesta sui tuoi dati scrivi a <a href="mailto:${esc(contact)}">${esc(contact)}</a>. Puoi anche presentare reclamo al <a href="https://www.garanteprivacy.it/">Garante per la protezione dei dati personali</a>.</p>`
    : "<p>Il modulo per i racconti non è ancora attivo: al momento, oltre ai log tecnici del servizio di hosting, non raccogliamo alcun dato.</p>"
}`;
  return page(
    {
      dir: "privacy",
      title: "Privacy",
      description: `Come ${SITE_NAME} tratta i racconti di chi ha fatto una pratica: cosa raccoglie, cosa pubblica, dove e per quanto.`,
      updated: site.updated,
      jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: "Privacy", inLanguage: "it" },
    },
    body,
    site,
  );
}

function renderThanks(site: Site): string {
  return page(
    {
      dir: "grazie",
      head: '<meta name="robots" content="noindex">\n',
      title: "Grazie",
      description: "Il tuo racconto è arrivato.",
      updated: site.updated,
      jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: "Grazie" },
    },
    `<h1>Grazie!</h1>
<p>Il tuo racconto è arrivato. Lo leggiamo prima di usarlo, e quando con altri racconti dice qualcosa di nuovo aggiorniamo la pagina della pratica.</p>
<p id="codice" hidden>Il codice del tuo racconto è <strong></strong>: conservalo se vorrai chiederci di vederlo o cancellarlo (<a href="../privacy/">privacy</a>).</p>
<p><a href="../">Torna a tutte le pratiche</a></p>
<script>
// The backend puts the report's code in the address's fragment, which no server sees.
const id = location.hash.slice(1);
if (/^[A-Za-z0-9]{20}$/.test(id)) {
  const p = document.getElementById("codice");
  p.querySelector("strong").textContent = id;
  p.hidden = false;
}
</script>`,
    site,
  );
}

// --- What people reported ---

const OUTCOME_TEXT: Record<string, [string, string]> = {
  completata: ["andata a buon fine", "andate a buon fine"],
  chiesto_altro: ["con una richiesta di altri documenti", "con una richiesta di altri documenti"],
  respinta: ["respinta", "respinte"],
  in_attesa: ["ancora in attesa", "ancora in attesa"],
  rinunciato: ["abbandonata", "abbandonate"],
};
const MONTH = new Intl.DateTimeFormat("it-IT", { month: "long", year: "numeric", timeZone: "UTC" });
// 16 €, but 66,50 € rather than 66,5 €.
const euro = (v: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR", minimumFractionDigits: Number.isInteger(v) ? 0 : 2 }).format(v);
const month = (m: string) => MONTH.format(new Date(`${m}-01T00:00:00Z`));
const nReports = (n: number) => (n === 1 ? "1 racconto" : `${n} racconti`);

// "in giornata", "circa 1 giorno", "circa 25 giorni"; "nessuna attesa" for 0 minutes.
const days = (n: number) => (n === 0 ? "in giornata" : `circa ${n} ${n === 1 ? "giorno" : "giorni"}`);
const minutes = (n: number) => (n === 0 ? "nessuna attesa" : `circa ${n} ${n === 1 ? "minuto" : "minuti"}`);

// "circa 25 giorni via PEC (7 racconti)", per channel with enough answers.
function answerTimes(r?: Reported): string | undefined {
  const parts = (r?.channels ?? []).flatMap((c) =>
    c.days_to_answer ? [`${days(c.days_to_answer.median)} via ${CHANNELS[c.type] ?? c.type} (${nReports(c.days_to_answer.n)})`] : [],
  );
  return parts.length ? parts.join("; ") : undefined;
}

// Not an official source: the section says where its figures come from.
function experiences(r: Reported, p: Procedure): string {
  const outcomes = Object.entries(r.outcomes ?? {}).map(([o, n]) => `${n} ${OUTCOME_TEXT[o]?.[n === 1 ? 0 : 1] ?? o}`);
  const items = [
    outcomes.length ? `<strong>Com'è finita</strong>: ${esc(outcomes.join(", "))}.` : "",
    ...(r.channels ?? []).flatMap((c) =>
      c.days_to_answer
        ? [
            `<strong>Risposta via ${esc(CHANNELS[c.type] ?? c.type)}</strong>: ${days(c.days_to_answer.median)} (${nReports(c.days_to_answer.n)}).`,
          ]
        : [],
    ),
    r.desk_wait_minutes
      ? `<strong>Attesa allo sportello</strong>: ${minutes(r.desk_wait_minutes.median)} (${nReports(r.desk_wait_minutes.n)}).`
      : "",
    r.paid_eur
      ? `<strong>Pagato in tutto</strong>: circa ${euro(r.paid_eur.median)} (${nReports(r.paid_eur.n)}).`
      : "",
    r.documents?.length
      ? `<strong>Documenti chiesti</strong>: ${r.documents.map((d) => `${esc(d.name)}, a ${d.asked} su ${d.of}`).join("; ")}.`
      : "",
    r.extra_documents?.length
      ? `<strong>Chiesti anche, pur non essendo in elenco</strong>: ${r.extra_documents.map((d) => `${esc(d.text)} (${nReports(d.count)})`).join("; ")}.`
      : "",
    r.rejection_reasons?.length
      ? `<strong>Perché è stata respinta</strong>: ${r.rejection_reasons.map((d) => `${esc(d.text)} (${nReports(d.count)})`).join("; ")}.`
      : "",
  ].filter(Boolean);
  const tips = r.tips?.length ? `<h3>Consigli</h3>\n${list(r.tips.map(esc))}` : "";
  return `<p class="meta">Da ${nReports(r.count)} di chi ha fatto la pratica tra ${month(r.period.from)} e ${month(r.period.to)}, letti da noi prima di pubblicarli; i consigli sono riscritti da noi. Non sono una fonte ufficiale: ${p.cost || p.duration ? "costi e termini ufficiali sono più su" : "per le regole valgono le fonti ufficiali"}.</p>
${items.length ? list(items) : ""}
${tips}`;
}

// --- Situations, about, updates ---

function situationList(situations: Situation[], root: string): string {
  const items = situations.map(
    (s) => `<li data-search="${esc([s.headline, ...(s.aka ?? []), s.intro].join(" "))}"><a href="${root}situazioni/${s.id}/">${esc(s.headline)}</a>
<p>${esc(s.intro)}</p></li>`,
  );
  return `<ul class="procedures">\n${items.join("\n")}\n</ul>`;
}

// "Fa parte di: Aprire un bar…, Chiudere un'attività…" under a procedure's dates.
function partOf(p: Procedure, site: Site): string {
  const root = rootFrom(p.id);
  const mine = site.situations.filter((s) => s.steps.some((x) => x.procedure === p.id));
  return mine.length
    ? `<p class="meta">Fa parte di: ${mine.map((s) => `<a href="${root}situazioni/${s.id}/">${esc(s.headline)}</a>`).join(" · ")}</p>\n`
    : "";
}

function renderSituations(site: Site): string {
  return page(
    {
      dir: "situazioni",
      title: "Le pratiche per situazione",
      description: "Aprire un bar o un negozio, chiudere un'attività, affittare ai turisti, una multa: tutte le pratiche di ogni situazione, a Napoli.",
      updated: latest(site.situations.map((s) => situationUpdated(s, site))),
      jsonLd: { "@context": "https://schema.org", "@type": "CollectionPage", name: "Le pratiche per situazione", inLanguage: "it" },
    },
    `<nav class="crumbs"><a href="../">Tutte le pratiche</a></nav>
<h1>Le pratiche per situazione</h1>
${situationList(site.situations, "../")}`,
    site,
  );
}

// Each step links to its procedure and repeats only that procedure's own
// deadline, with its status: the facts and their sources stay there.
function renderSituation(s: Situation, site: Site): string {
  const root = rootFrom(`situazioni/${s.id}`);
  const updated = situationUpdated(s, site);
  const noCite: Cite = () => "";
  const steps = s.steps.map((step) => {
    const p = site.byId.get(step.procedure)!;
    const due = deadlineSummary(p);
    return `<li><a href="${root}${p.id}/">${esc(heading(p))}</a>
<p>${esc(step.when)}</p>${due ? `\n<p class="note">Scadenza: ${claim(due, noCite)}</p>` : ""}</li>`;
  });
  const url = `${site.opts.baseUrl}/situazioni/${s.id}/`;
  return page(
    {
      dir: `situazioni/${s.id}`,
      title: s.headline,
      description: s.intro,
      updated,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "WebPage",
        name: s.headline,
        ...(s.aka?.length ? { alternateName: s.aka } : {}),
        description: s.intro,
        url,
        inLanguage: "it",
        dateModified: updated,
        breadcrumb: breadcrumbs(site, [
          ["Per situazione", "situazioni"],
          [s.headline, `situazioni/${s.id}`],
        ]),
        mainEntity: {
          "@type": "ItemList",
          itemListElement: s.steps.map((step, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: heading(site.byId.get(step.procedure)!),
            url: `${site.opts.baseUrl}/${step.procedure}/`,
          })),
        },
      },
    },
    `<nav class="crumbs"><a href="${root}">Tutte le pratiche</a> › <a href="${root}situazioni/">Per situazione</a></nav>
<h1>${esc(s.headline)}</h1>
${s.aka?.length ? `<p class="meta">Conosciuta anche come: ${esc(s.aka.join(", "))}</p>\n` : ""}<p class="lead">${esc(s.intro)}</p>
<p class="meta">Aggiornata il ${time(updated)}</p>
<ol class="steps">
${steps.join("\n")}
</ol>`,
    site,
  );
}

function renderAbout(site: Site): string {
  const contact = site.opts.reports?.contact;
  const repo = site.opts.repoUrl;
  const body = `<h1>Come lavoriamo</h1>
<p class="lead">${SITE_NAME} spiega le pratiche burocratiche di Napoli in modo chiaro, con le fonti ufficiali per ogni informazione. È un progetto indipendente: non è un sito del Comune di Napoli né di altri enti.</p>
<h2>Da dove vengono le informazioni</h2>
<p>Ogni pratica è scritta leggendo le fonti ufficiali dell'ente: pagine, regolamenti, delibere e moduli. Ogni affermazione cita la sua fonte, numerata in fondo alla pagina, e dice se è <strong>verificata</strong> su una fonte ufficiale, <span class="badge">da verificare</span> o con <span class="badge">fonti in contrasto</span>, quando le fonti ufficiali non concordano. Le guide di terzi servono solo a trovare le pagine ufficiali.</p>
<h2>Quanto è verificata una pratica</h2>
<ul>
<li><strong>L0</strong>: ${esc(LEVELS.L0)}.</li>
<li><strong>L1</strong>: ${esc(LEVELS.L1)}.</li>
<li><strong>L2</strong>: ${esc(LEVELS.L2)}.</li>
<li><strong>L3</strong>: ${esc(LEVELS.L3)}.</li>
</ul>
<h2>Le date</h2>
<p>Ogni pagina dice quando è stata aggiornata l'ultima volta e quando è stata verificata. Un controllo automatico verifica ogni notte i moduli ufficiali citati (e una volta a settimana li riscarica per intero), e ogni settimana le pagine, e segnala i moduli cambiati e gli indirizzi non più raggiungibili, perché vengano ricontrollati. Le pagine cambiate di recente sono negli <a href="../aggiornamenti/">aggiornamenti</a>.</p>
<h2>I racconti di chi ha fatto la pratica</h2>
<p>Chi ha fatto una pratica può raccontare com'è andata. Leggiamo ogni racconto prima di usarlo e pubblichiamo solo statistiche, quando ogni numero viene da almeno 3 racconti, e consigli riscritti da noi: mai un racconto così com'è. Sono indicati come racconti, non come fonti ufficiali. <a href="../privacy/">Come trattiamo i dati</a></p>
<h2>Errori e correzioni</h2>
<p>Ogni pagina ha un modo per segnalare un errore. Correggiamo la pratica dopo averlo ricontrollato sulle fonti, e annotiamo gli errori che troviamo nelle fonti ufficiali stesse nel <a href="${esc(`${repo}/blob/main/docs/discrepancies.md`)}">registro delle discrepanze</a>. La storia di ogni modifica è pubblica su <a href="${esc(repo)}">GitHub</a>.</p>
<h2>Dati aperti</h2>
<p>Ogni pratica è disponibile anche in JSON, con l'elenco completo in <a href="../procedures.json">procedures.json</a> e una mappa per gli assistenti AI in <a href="../llms.txt">llms.txt</a>. I contenuti sono sotto licenza <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.it">CC BY-SA 4.0</a>, il codice sotto licenza MIT.</p>
<h2>Non è consulenza legale</h2>
<p>Le informazioni servono a capire e preparare una pratica. Prima di agire controlla sempre la fonte ufficiale citata, o chiedi all'ufficio.</p>
<h2>Contatti</h2>
<p>${contact ? `Scrivi a <a href="mailto:${esc(contact)}">${esc(contact)}</a>, o apri una segnalazione su <a href="${esc(repo)}">GitHub</a>.` : `Apri una segnalazione su <a href="${esc(repo)}">GitHub</a> (è pubblica: non scrivere dati personali).`}</p>`;
  return page(
    {
      dir: "come-lavoriamo",
      title: "Come lavoriamo",
      description: `Come ${SITE_NAME} scrive e verifica le pratiche: fonti ufficiali, livelli di verifica, date, racconti di chi le ha fatte, correzioni.`,
      updated: site.updated,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "AboutPage",
        name: "Come lavoriamo",
        inLanguage: "it",
        about: { "@type": "Organization", name: SITE_NAME, url: `${site.opts.baseUrl}/` },
      },
    },
    body,
    site,
  );
}

// The 50 most recent changes to procedures and situations, newest first.
function renderUpdates(procedures: Procedure[], site: Site): string {
  const repo = site.opts.repoUrl;
  const entries = [
    ...procedures.map((p) => ({ updated: p.updated, title: heading(p), href: `../${p.id}/`, file: `procedures/${p.id}.yaml` })),
    ...site.situations.map((s) => ({ updated: s.updated, title: s.headline, href: `../situazioni/${s.id}/`, file: `situations/${s.id}.yaml` })),
  ]
    .sort((a, b) => b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title, "it"))
    .slice(0, 50);
  const items = entries.map(
    (e) =>
      `<li>${time(e.updated)}: <a href="${e.href}">${esc(e.title)}</a> <span class="note">(<a href="${esc(`${repo}/commits/main/${e.file}`)}">cosa è cambiato</a>)</span></li>`,
  );
  return page(
    {
      dir: "aggiornamenti",
      title: "Aggiornamenti",
      description: `Le pratiche e le situazioni aggiornate di recente su ${SITE_NAME}, con la storia delle modifiche.`,
      updated: site.updated,
      jsonLd: { "@context": "https://schema.org", "@type": "CollectionPage", name: "Aggiornamenti", inLanguage: "it", dateModified: site.updated },
    },
    `<h1>Aggiornamenti</h1>
<p class="lead">Le pagine cambiate di recente, dalla più nuova. Per ognuna, la storia delle modifiche è su GitHub.</p>
<ul>
${items.join("\n")}
</ul>`,
    site,
  );
}
