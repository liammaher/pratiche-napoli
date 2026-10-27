// Checks a procedure against contract/procedure.schema.json and the rules a
// JSON Schema can't express: field IDs exist in the registry and never reach a
// secret, references point somewhere real, verified claims cite an official
// source, dates aren't in the future (nor after `updated`), and no personal
// data slipped in.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import { isCredentialName, type Registry } from "../gen-fields.ts";
import { findPersonalData } from "./personal.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const schema = JSON.parse(readFileSync(path.join(ROOT, "contract", "procedure.schema.json"), "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: true });
addFormats.default(ajv);
const checkSchema = ajv.compile(schema);

// The law's rule for signing on each channel type (contract/signing.json); a
// form's own signing lists only where it differs.
export interface SigningRule {
  ways: string[];
  id_copy: string;
  source: string;
  text: string;
}
type Signing = { channels: Record<string, SigningRule>; sources: { id: string }[] };
const checkSigning = ajv.compile(JSON.parse(readFileSync(path.join(ROOT, "contract", "signing.schema.json"), "utf8")));
export const SIGNING: Signing = (() => {
  const doc: Signing = JSON.parse(readFileSync(path.join(ROOT, "contract", "signing.json"), "utf8"));
  if (!checkSigning(doc)) throw new Error(`contract/signing.json: ${JSON.stringify(checkSigning.errors)}`);
  const ids = new Set(doc.sources.map((x) => x.id));
  for (const [t, r] of Object.entries(doc.channels)) {
    if (!ids.has(r.source)) throw new Error(`contract/signing.json: ${t} cites unknown source ${r.source}`);
  }
  return doc;
})();

// Channel types sent or handed in one way each, so each needs a step of its own.
const ROUTES_WITH_STEPS = new Set(["pec", "email", "post", "desk"]);

export function loadRegistry(): Registry {
  return JSON.parse(readFileSync(path.join(ROOT, "contract", "fields.json"), "utf8"));
}

// Today's date in Naples, so work done just after midnight isn't "in the future".
export function todayInRome(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Rome" }).format(now);
}

// A person's slug, as the vault's reMemberSlug; "io" is reserved.
const MEMBER_SLUG = /^[a-z][a-z0-9-]{0,31}$/;
// Secrets named in an ask or blank_with_reason text. "PIN 2.1" etc.
// are the Vigili del Fuoco form names, not PIN codes.
const ASKS_FOR_SECRET = /\b(pin(?!\s*\d)|puk|password|passcode|otp|codice segreto|codic[ei] (di )?sblocco)\b/i;
// Credentials as a whole, only in an ask: one asked of the person is a login,
// while a blank_with_reason may well say an office hands some out.
const ASKS_FOR_CREDENTIALS = /\bcredenzial[ei]\b/i;
// The ruoli that give a business a procura (the procura category): a client,
// so the business can act for them. A procuratore holds the business's procura,
// the other way round. Listed, not excluded, so a new ruolo stays refused.
const GIVES_PROCURA = new Set(["cliente"]);

export interface Context {
  registry: Registry;
  // ids of every procedure in the library (from file paths), for `related`
  knownIds: Set<string>;
  today: string; // YYYY-MM-DD
  // fields with a valid offices/<field>.json, which a desk's office may name
  // (default: this library's)
  offices?: Set<string>;
}

// Procedure documents are plain YAML data; this is the subset the checks read.
type Condition = { field: string; equals?: string; matches?: string };
export interface Row {
  label: string;
  map: Record<string, unknown>;
  notes?: string;
  optional?: { field: string; required_if?: Condition[] }[];
  choices?: { box: string; values: string[]; write_value?: boolean }[];
  when?: { field: string; ticks: string[] };
}
interface Source {
  id: string;
  url?: string;
  official?: boolean;
  retrieved?: string;
  page_updated?: string;
}
interface Doc {
  id?: string;
  updated?: string;
  channels?: { type?: string; purpose?: string; preferred?: boolean; auth?: string[]; address?: string; url?: string; office?: string }[];
  deadline?: { summary?: unknown; rules?: { compute?: { from: string; days: number } }[] };
  documents?: { name: string }[];
  reported?: {
    generated: string;
    period: { from: string; to: string };
    count: number;
    outcomes?: Record<string, number>;
    channels?: { count: number; days_to_answer?: { n: number } }[];
    desk_wait_minutes?: { n: number };
    paid_eur?: { n: number };
    documents?: { name: string; asked: number; of: number }[];
    extra_documents?: { text: string; count: number }[];
    rejection_reasons?: { count: number }[];
    basis: string[];
  };
  sources?: Source[];
  applies_to?: { audience?: string[] };
  dichiarante?: unknown;
  forms?: {
    id: string;
    sha256?: string;
    signature_required?: boolean;
    signing?: { channel: string; ways: string[]; id_copy: string; status: string }[];
    fields?: Row[];
  }[];
  steps?: { human_only?: boolean; gate?: string; channel?: string[] }[];
  records?: { field: string }[];
  related?: string[];
  run_log?: { date: string }[];
  verification?: { level?: string; date?: string };
  [key: string]: unknown;
}

export function validateProcedure(doc: unknown, relPath: string, ctx: Context): string[] {
  const errors: string[] = [];
  if (!checkSchema(doc)) {
    // A field mapping that matches no branch makes ajv report every branch,
    // and the oneOfs inside it (party, repeat) once per branch; replace all of
    // that with one message.
    const all = checkSchema.errors ?? [];
    const badMaps = all
      .filter((e) => e.keyword === "oneOf" && e.instancePath.endsWith("/map"))
      .map((e) => e.instancePath);
    for (const e of all) {
      const inBadMap = badMaps.some((p) => e.instancePath === p || e.instancePath.startsWith(`${p}/`));
      if (inBadMap && !(e.keyword === "oneOf" && badMaps.includes(e.instancePath))) continue;
      const message = inBadMap
        ? "must be exactly one of direct, concat (2+), fallback (2+) (each may add party: { ruolo }), " +
          "repeat: famiglia or repeat: { ruolo } with fields, blank_with_reason or ask, " +
          "with field IDs like identity.email and ruolo values from $defs/ruolo"
        : e.message;
      const line = `schema: ${e.instancePath || "/"} ${message}`;
      if (!errors.includes(line)) errors.push(line);
    }
    return errors;
  }
  const d = doc as Doc;

  const expectedId = procedureIdFromPath(relPath);
  if (d.id !== expectedId) errors.push(`id "${d.id}" must match its path "${expectedId}"`);

  const sources = new Map<string, Source>();
  for (const s of d.sources ?? []) {
    if (sources.has(s.id)) errors.push(`duplicate source id "${s.id}"`);
    sources.set(s.id, s);
    if (s.retrieved && s.retrieved > ctx.today) errors.push(`source "${s.id}" retrieved in the future`);
    if (s.page_updated && s.page_updated > ctx.today) errors.push(`source "${s.id}" updated in the future`);
    if (s.page_updated && s.retrieved && s.page_updated > s.retrieved) {
      errors.push(`source "${s.id}" was updated after it was retrieved`);
    }
  }

  const formIds = new Set<string>();
  for (const f of d.forms ?? []) {
    if (formIds.has(f.id)) errors.push(`duplicate form id "${f.id}"`);
    formIds.add(f.id);
    const labels = new Set<string>();
    for (const field of f.fields ?? []) {
      if (labels.has(field.label)) errors.push(`form "${f.id}": two fields are labelled "${field.label}"`);
      labels.add(field.label);
      const problems = [
        ...checkMapping(field.map, ctx.registry, d.dichiarante !== undefined, field.notes),
        ...checkRowExtras(field, ctx.registry, d.dichiarante !== undefined),
        ...whenProblems(field, f.fields ?? []),
      ];
      for (const problem of problems) errors.push(`form "${f.id}", field "${field.label}": ${problem}`);
    }
  }

  // How each channel takes the signature: a form plus a channel decides it.
  // (An unknown `source` and a verified `status` without one are caught by the walk below.)
  const channelsOf = (type: string) => (d.channels ?? []).filter((c) => c.type === type && c.purpose === "procedure");
  for (const f of d.forms ?? []) {
    if (!f.signing) continue;
    if (!f.signature_required) errors.push(`form "${f.id}": signing needs signature_required: true`);
    const seen = new Set<string>();
    for (const entry of f.signing) {
      if (seen.has(entry.channel)) errors.push(`form "${f.id}": signing lists channel ${entry.channel} twice`);
      seen.add(entry.channel);
      const channels = channelsOf(entry.channel);
      if (!channels.length) {
        errors.push(`form "${f.id}": signing for channel ${entry.channel}, which the procedure doesn't list with purpose "procedure"`);
      } else if (entry.ways.includes("login") && !channels.some((c) => (c.auth ?? []).some((a) => a !== "none"))) {
        errors.push(`form "${f.id}": signing way "login" on channel ${entry.channel}, which lists no auth (spid, cie, cns) to sign in with`);
      }
      const rule = SIGNING.channels[entry.channel];
      if (rule && entry.status !== "disputed" && sameSet(entry.ways, rule.ways) && entry.id_copy === rule.id_copy) {
        errors.push(`form "${f.id}": signing for channel ${entry.channel} repeats contract/signing.json: drop it`);
      }
    }
  }
  const procedureTypes = new Set((d.channels ?? []).filter((c) => c.purpose === "procedure").map((c) => c.type));
  (d.steps ?? []).forEach((step, i) => {
    if (step.gate && !step.human_only) errors.push(`steps/${i}: gate ${step.gate} carries a human_only step, so it needs human_only: true`);
    for (const t of step.channel ?? []) {
      if (!procedureTypes.has(t)) errors.push(`steps/${i}: channel ${t}, which the procedure doesn't list with purpose "procedure"`);
    }
  });
  // Every route is mapped end to end: how to send or hand in the form that way.
  for (const t of procedureTypes) {
    if (t && ROUTES_WITH_STEPS.has(t) && !(d.steps ?? []).some((s) => s.channel?.includes(t))) {
      errors.push(`channel ${t} has no step of its own: add one with channel: [${t}] saying how to send or hand it in that way`);
    }
  }
  (d.channels ?? []).forEach((c, i) => {
    if (c.type === "desk" && c.purpose === "procedure" && !c.address && !c.office && !c.url) {
      errors.push(`channels/${i}: a desk needs an address, an office (residenza.municipalita) or a url that finds one`);
    }
    if (!c.office) return;
    const kind = c.office.slice(c.office.lastIndexOf(".") + 1);
    const problem = checkUse(c.office, false, ctx.registry, d.dichiarante !== undefined);
    if (c.type !== "desk") errors.push(`channels/${i}: office is for a desk, not ${c.type}`);
    if (c.address) errors.push(`channels/${i}: office picks the address, so give one or the other`);
    if (problem) errors.push(`channels/${i}: office ${problem}`);
    else if (!(ctx.offices ?? officeFields(path.join(ROOT, "offices"))).has(kind)) {
      errors.push(`channels/${i}: office ${c.office}: no valid offices/${kind}.json`);
    }
  });

  (d.deadline?.rules ?? []).forEach((rule, i) => {
    if (!rule.compute) return;
    const from = rule.compute.from;
    const problem = from.endsWith(".*") ? `${from}: name one date field` : checkUse(from, false, ctx.registry, d.dichiarante !== undefined);
    if (problem) errors.push(`deadline/rules/${i}/compute: ${problem}`);
  });

  const recorded = new Set<string>();
  for (const r of d.records ?? []) {
    if (recorded.has(r.field)) errors.push(`records: "${r.field}" is listed twice`);
    recorded.add(r.field);
    const problem = checkUse(r.field, false, ctx.registry, d.dichiarante !== undefined);
    if (problem) errors.push(`records: ${problem}`);
  }

  // A dichiarante signs for a business: on a procedure only residents do, it
  // would hand a business vault's legale rappresentante a person's own form.
  if (d.dichiarante !== undefined && !d.applies_to?.audience?.includes("business")) {
    errors.push("declares a dichiarante, who signs for a business, but applies_to.audience has no business");
  }

  // Forms or records with the business's data and a person's need to say
  // whose that person's is: in a business vault there's no one else it could be.
  if (d.dichiarante === undefined) {
    const refs = [
      ...(d.forms ?? []).flatMap((f) => (f.fields ?? []).flatMap((x) => (x.map.party ? [] : [...directRefs(x.map), ...templateFieldRefs(x.map)]))),
      ...(d.records ?? []).map((r) => r.field),
    ].filter((ref) => !splitMember(ref).member);
    const isBusiness = (ref: string) => ["business", "locale"].includes(categoryOf(ref));
    // Anything else a person keeps: identity, residenza, but also addresses or preferences.
    const isPerson = (ref: string) => registryCategory(ref, ctx.registry)?.scope === "person" && !isBusiness(ref);
    const business = refs.find(isBusiness);
    const person = refs.find(isPerson);
    if (business && person) {
      errors.push(`uses the business's ${business} and a person's ${person}: say who signs with dichiarante: { ruolo: [...] }`);
    }
  }

  walk(d, "", (p, value, parent) => {
    if (typeof value === "string") {
      for (const what of new Set(findPersonalData(value))) {
        errors.push(`${p}: looks like a ${what}; procedures must not contain personal data`);
      }
    }
    if (p.endsWith("/source") && typeof value === "string" && !sources.has(value)) {
      errors.push(`${p}: unknown source "${value}"`);
    }
    if (p.endsWith("/status") && parent && typeof parent === "object") {
      const claim = parent as { status: string; source?: string };
      if (claim.status === "verified") {
        if (!claim.source) errors.push(`${p}: a verified claim must cite a source`);
        else if (sources.has(claim.source) && !sources.get(claim.source)?.official) {
          errors.push(`${p}: a verified claim must cite an official source, not "${claim.source}"`);
        }
      }
    }
  });

  if (!(d.channels ?? []).some((c) => c.purpose === "procedure")) {
    errors.push('channels: at least one must have purpose "procedure", the way to carry it out');
  }
  (d.channels ?? []).forEach((c, i) => {
    if (c.preferred && c.purpose !== "procedure") {
      errors.push(`channels/${i}: preferred marks the recommended way to carry out the procedure, so its purpose must be "procedure"`);
    }
  });
  // One rule can stand alone in "In breve"; several need a summary that covers every case.
  if ((d.deadline?.rules?.length ?? 0) > 1 && !d.deadline?.summary) {
    errors.push("deadline: with more than one rule, add a summary covering every case");
  }

  // Generated by reports:aggregate; these keep a hand edit from slipping through.
  const rep = d.reported;
  if (rep) {
    if (rep.generated > ctx.today) errors.push("reported was generated in the future");
    if (rep.period.from > rep.period.to) errors.push("reported period starts after it ends");
    const listed = new Set((d.documents ?? []).map((doc) => doc.name));
    // What the counts leave over beside the total would be someone's result.
    const leftover = (n: number) => n !== 0 && n < 3;
    const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);
    for (const doc of rep.documents ?? []) {
      if (!listed.has(doc.name)) errors.push(`reported document "${doc.name}" is not in documents`);
      if (doc.asked > doc.of) errors.push(`reported document "${doc.name}" was asked more often than reported`);
      else if (leftover(doc.of - doc.asked)) errors.push(`reported document "${doc.name}": those not asked must be none or at least 3`);
      if (leftover(rep.count - doc.of)) errors.push(`reported document "${doc.name}": those who didn't say must be none or at least 3`);
    }
    // Each figure's answers against the total they come from.
    const parts: [string, number | undefined, number][] = [
      ["desk_wait_minutes", rep.desk_wait_minutes?.n, rep.count],
      ["paid_eur", rep.paid_eur?.n, rep.count],
      ...(rep.channels ?? []).map((c, i): [string, number | undefined, number] => [`channels/${i}/days_to_answer`, c.days_to_answer?.n, c.count]),
    ];
    for (const [what, n, total] of parts) {
      if (n !== undefined && leftover(total - n)) errors.push(`reported ${what}: those who didn't answer must be none or at least 3`);
    }
    if (rep.rejection_reasons) {
      const refused = rep.outcomes?.respinta;
      if (refused === undefined) errors.push("reported rejection_reasons need the count of refusals in outcomes");
      else if (leftover(refused - sum(rep.rejection_reasons.map((r) => r.count)))) {
        errors.push("reported rejection_reasons leave 1 or 2 refusals over");
      }
    }
    if (rep.outcomes && leftover(rep.count - sum(Object.values(rep.outcomes)))) {
      errors.push("reported outcomes leave 1 or 2 reports over beside the count");
    }
    if (rep.channels && leftover(rep.count - sum(rep.channels.map((c) => c.count)))) {
      errors.push("reported channels leave 1 or 2 reports over beside the count");
    }
    // One extra document per report, so the texts divide the reports too.
    if (rep.extra_documents && leftover(rep.count - sum(rep.extra_documents.map((d) => d.count)))) {
      errors.push("reported extra_documents leave 1 or 2 reports over beside the count");
    }
    if (rep.basis.length !== rep.count) errors.push(`reported basis has ${rep.basis.length} reports, but count is ${rep.count}`);
  }

  for (const r of d.related ?? []) {
    if (r === d.id) errors.push("a procedure can't be related to itself");
    else if (!ctx.knownIds.has(r)) errors.push(`related "${r}" is not a procedure in the library`);
  }

  for (const entry of d.run_log ?? []) {
    if (entry.date > ctx.today) errors.push(`run_log entry dated ${entry.date} is in the future`);
  }

  const v = d.verification ?? {};
  if (v.date && v.date > ctx.today) errors.push("verification date is in the future");

  // Re-checking a source, verifying or logging a run is a change too, so
  // none of them can be newer than the procedure's last update.
  if (d.updated) {
    if (d.updated > ctx.today) errors.push("updated is in the future");
    const later = [
      ...(v.date && v.date > d.updated ? [`verification (${v.date})`] : []),
      ...(d.sources ?? []).filter((s) => s.retrieved && s.retrieved > d.updated!).map((s) => `source "${s.id}" (${s.retrieved})`),
      ...(d.run_log ?? []).filter((e) => e.date > d.updated!).map((e) => `run_log entry ${e.date}`),
      ...(d.reported && d.reported.generated > d.updated ? [`reported (${d.reported.generated})`] : []),
    ];
    if (later.length) errors.push(`updated ${d.updated} is older than ${later.join(", ")}: bump it`);
  }
  if (v.level && v.level !== "L0" && !(d.sources ?? []).some((s) => s.official && s.url)) {
    errors.push(`level ${v.level} needs at least one official source with a URL`);
  }

  return errors;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export function procedureIdFromPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^procedures\//, "").replace(/\.ya?ml$/i, "");
}

// The fields a mapping reads directly (not a repeat's rows).
function directRefs(map: Record<string, unknown>): string[] {
  return [
    ...(typeof map.direct === "string" ? [map.direct] : []),
    ...["concat", "fallback"].flatMap((key) => (Array.isArray(map[key]) ? (map[key] as string[]) : [])),
  ];
}

// --- Templates, optional fields and boxes to tick ---

export type TemplateNode = { text: string } | { name: string; filter: string } | { group: TemplateNode[] };

// The template language ($defs/template), as consumers read it: {name} or
// {name|filter}, [a part left out when a field in it is empty], \x for x.
export function parseTemplate(template: string): TemplateNode[] {
  const stack: TemplateNode[][] = [[]];
  const where = JSON.stringify(template);
  for (let i = 0; i < template.length; i++) {
    const c = template[i];
    const top = stack[stack.length - 1];
    if (c === "\\" && i + 1 < template.length) {
      top.push({ text: template[++i] });
    } else if (c === "{") {
      const end = template.indexOf("}", i);
      if (end < 0) throw new Error(`unclosed { in ${where}`);
      const [name, ...filters] = template.slice(i + 1, end).split("|");
      top.push({ name, filter: filters.join("|") });
      i = end;
    } else if (c === "}") {
      throw new Error(`unmatched } in ${where}`);
    } else if (c === "[") {
      stack.push([]);
    } else if (c === "]") {
      if (stack.length === 1) throw new Error(`unmatched ] in ${where}`);
      const group = stack.pop()!;
      stack[stack.length - 1].push({ group });
    } else {
      top.push({ text: c });
    }
  }
  if (stack.length !== 1) throw new Error(`unclosed [ in ${where}`);
  return stack[0];
}

// |date writes DD/MM/YYYY; |or:TEXT is what an empty field means (Italia
// for an empty stato), so the field may be empty.
function filterProblem(filter: string): string | null {
  if (!filter || filter === "date" || filter === "digits" || /^or:\S.*$/.test(filter)) return null;
  return `unknown filter |${filter} (only |date, |digits and |or:TEXT)`;
}

// Every {name} in a template, and whether it is inside a [...] part.
function templateNames(nodes: TemplateNode[], inGroup = false): { name: string; filter: string; inGroup: boolean }[] {
  return nodes.flatMap((n) =>
    "group" in n ? templateNames(n.group, true) : "name" in n ? [{ name: n.name, filter: n.filter, inGroup }] : [],
  );
}

// The fields a row's template names outright (not {.field} or {relazione}).
function templateFieldRefs(map: Record<string, unknown>): string[] {
  if (typeof map.template !== "string") return [];
  try {
    return templateNames(parseTemplate(map.template)).map((n) => n.name).filter((n) => n.includes(".") && !n.startsWith("."));
  } catch {
    return []; // reported by checkRowExtras
  }
}

// Conditions are read by JavaScript and Python consumers alike.
function regexProblem(source: string): string | null {
  try {
    new RegExp(source);
  } catch {
    return `${JSON.stringify(source)} isn't a regular expression`;
  }
  if (/\(\?<[=!]/.test(source)) return `${JSON.stringify(source)} looks behind, which not every consumer reads`;
  if (/\(\?P?<[A-Za-z]/.test(source)) return `${JSON.stringify(source)} names a group, which not every consumer reads alike`;
  return null;
}

// "domicilio.indirizzo" and "civico" give "domicilio.civico", keeping any person prefix.
function siblingOf(ref: string, field: string): string {
  const { member, local } = splitMember(ref);
  return `${member ? `${member}:` : ""}${local.split(".")[0]}.${field}`;
}

// What a row adds to its map: a template, columns for a repeat, the fields
// that may be empty (and when they may not), and boxes to tick.
function checkRowExtras(row: Row, registry: Registry, dichiarante: boolean): string[] {
  const out: string[] = [];
  const m = row.map;
  const fallback = Array.isArray(m.fallback) ? (m.fallback as string[]) : undefined;
  const isRepeat = m.repeat !== undefined;
  const party = m.party as { ruolo?: unknown } | undefined;
  const useRef = (ref: string) =>
    party ? checkPartyRef(ref, registry) ?? procuraProblem(ref, party.ruolo) : checkUse(ref, false, registry, dichiarante);
  // What the row reads, which is what optional may name.
  const reads = new Set<string>([...directRefs(m), ...(isRepeat && Array.isArray(m.fields) ? (m.fields as string[]) : [])]);

  if (typeof m.template === "string") {
    let names: ReturnType<typeof templateNames> = [];
    try {
      names = templateNames(parseTemplate(m.template));
    } catch (e) {
      out.push(`template: ${(e as Error).message}`);
    }
    for (const { name, filter } of names) {
      if (filterProblem(filter)) out.push(`template: ${filterProblem(filter)}`);
      if (name === "relazione") {
        out.push("template: {relazione} is a family member's, for a repeat: famiglia's columns");
      } else if (name.startsWith(".")) {
        if (!fallback) {
          out.push(`template: {${name}} is a field of the place a fallback picked, and this row has no fallback`);
          continue;
        }
        for (const f of fallback) {
          const problem = useRef(siblingOf(f, name.slice(1)));
          if (problem) out.push(`template: {${name}} for ${f}: ${problem}`);
        }
        reads.add(name);
      } else if (name.endsWith(".*")) {
        out.push(`template: {${name}} must name one field`);
      } else {
        const problem = useRef(name);
        if (problem) out.push(`template: ${problem}`);
        reads.add(name);
      }
    }
    const used = new Set(names.map((n) => n.name));
    const named = names.map((n) => n.name).filter((n) => n.includes(".") && !n.startsWith("."));
    if (fallback) {
      // The template follows whichever place the fallback picks.
      const own = new Set(fallback.map((f) => f.split(".").pop()));
      if (own.size !== 1) out.push("template: a fallback's sources must be the same field of each place, which {.field} names");
      else if (!used.has(`.${[...own][0]}`)) out.push(`template: write the fallback's own field as {.${[...own][0]}}`);
      const places = named.filter((n) => placeOf(n));
      if (places.length) out.push(`template: ${places.join(", ")} would mix another place into the one the fallback picks`);
    } else {
      for (const r of directRefs(m)) if (!used.has(r)) out.push(`template: doesn't use ${r}`);
      const places = [...new Set([...directRefs(m), ...named].flatMap((r) => placeOf(r) ?? []))];
      if (places.length > 1) out.push(`template joins ${places.join(" and ")}: an address's parts come from one place`);
    }
  }

  if (Array.isArray(m.columns)) {
    const fields = new Set(Array.isArray(m.fields) ? (m.fields as string[]) : []);
    const labels = new Set<string>();
    for (const col of m.columns as { label: string; template: string }[]) {
      if (labels.has(col.label)) out.push(`two columns are labelled "${col.label}"`);
      labels.add(col.label);
      let names: ReturnType<typeof templateNames> = [];
      try {
        names = templateNames(parseTemplate(col.template));
      } catch (e) {
        out.push(`column "${col.label}": ${(e as Error).message}`);
      }
      for (const { name, filter } of names) {
        if (filterProblem(filter)) out.push(`column "${col.label}": ${filterProblem(filter)}`);
        if (name === "relazione") {
          if (m.repeat !== "famiglia") out.push(`column "${col.label}": {relazione} is a family member's; people picked by ruolo have none`);
        } else if (!fields.has(name)) {
          out.push(`column "${col.label}": {${name}} isn't one of the row's fields`);
        }
      }
    }
  }

  if (row.optional) {
    if (m.ask !== undefined || m.blank_with_reason !== undefined) out.push("optional: an ask or a blank row reads no fields");
    const seen = new Set<string>();
    for (const o of row.optional) {
      if (seen.has(o.field)) out.push(`optional: ${o.field} is listed twice`);
      seen.add(o.field);
      if (!reads.has(o.field)) out.push(`optional: ${o.field} isn't a field this row reads`);
      for (const c of o.required_if ?? []) {
        const each = splitMember(c.field).member === "*";
        const problem = c.field.endsWith(".*")
          ? `${c.field}: name one field`
          : isRepeat
            ? each
              ? checkUse(c.field, true, registry, false)
              : `${c.field}: in a repeat, a condition is on each person's fields, written *:category.field`
            : splitMember(c.field).member
              ? `${c.field}: write the field as the row does, without a prefix`
              : useRef(c.field);
        if (problem) out.push(`optional ${o.field}, required_if: ${problem}`);
        const bad = c.matches === undefined ? null : regexProblem(c.matches);
        if (bad) out.push(`optional ${o.field}, required_if: ${bad}`);
      }
    }
  }

  if (row.choices) {
    // A fallback's value is its first field with one: the signer's role,
    // business.qualita_dichiarante or ruolo.tipo.
    const one = ((m.direct !== undefined || m.fallback !== undefined) && m.template === undefined && !party) || m.ask !== undefined;
    if (!one) out.push("choices: only a row of one field (direct or fallback, without a template) or an ask is boxes to tick");
    const boxes = new Set<string>();
    const values = new Map<string, string>();
    for (const c of row.choices) {
      if (boxes.has(c.box)) out.push(`choices: two boxes are "${c.box}"`);
      boxes.add(c.box);
      for (const v of c.values) {
        if (values.has(v)) out.push(`choices: "${v}" ticks both "${values.get(v)}" and "${c.box}"`);
        values.set(v, c.box);
      }
    }
    if (row.choices.filter((c) => c.write_value).length > 1) out.push("choices: only one box can have the value written next to it");
  }
  return out;
}

// when: the row it depends on is an ask of the same form with these boxes.
function whenProblems(row: Row, rows: Row[]): string[] {
  if (!row.when) return [];
  const other = rows.find((r) => r.label === row.when!.field);
  if (!other || other === row) return [`when: no other field "${row.when.field}" on this form`];
  if (other.map.ask === undefined || !other.choices) return [`when: "${row.when.field}" isn't an ask with boxes to tick`];
  if (other.when) return [`when: "${row.when.field}" has a when of its own`];
  const boxes = new Set(other.choices.map((c) => c.box));
  return row.when.ticks.filter((t) => !boxes.has(t)).map((t) => `when: "${row.when!.field}" has no box "${t}"`);
}

// The places an address can come from: a person's residenza or domicilio,
// the business's premises (locale) or its registered office. An address is
// taken whole from one of them (see addressProblem).
const HOMES = new Set(["residenza", "domicilio"]);
// A numbered copy is a place of its own: locale2 is a second premises.
function placeOf(ref: string): string | undefined {
  const [written, field] = splitMember(ref).local.split(".", 2);
  const category = categoryOf(ref);
  if (HOMES.has(category) || category === "locale") return written;
  if (category !== "business" || !field.startsWith("sede_legale_")) return undefined;
  return written === category ? "sede legale" : `sede legale of ${written}`;
}

// dichiarante: the procedure names who signs, so a person's own data is theirs.
function checkMapping(map: Record<string, unknown>, registry: Registry, dichiarante: boolean, notes?: string): string[] {
  const problems: string[] = [];
  const refs = directRefs(map);
  const address = addressProblem(map, notes);
  if (address) problems.push(address);

  for (const key of ["ask", "blank_with_reason"]) {
    const text = map[key];
    if (typeof text === "string" && (ASKS_FOR_SECRET.test(text) || (key === "ask" && ASKS_FOR_CREDENTIALS.test(text)))) {
      problems.push(`${key} must not ask for a PIN, password or other secret`);
    }
  }
  for (const ref of refs) {
    const problem = map.party
      ? checkPartyRef(ref, registry) ?? procuraProblem(ref, (map.party as { ruolo?: unknown }).ruolo)
      : checkUse(ref, false, registry, dichiarante);
    if (problem) problems.push(problem);
  }
  // repeat fills one row per person (a family member, or someone with a
  // ruolo), from that person's fields.
  if (map.repeat !== undefined) {
    const byRuolo = typeof map.repeat === "object";
    if (byRuolo && (map.repeat as { except?: string }).except === "dichiarante" && !dichiarante) {
      problems.push("except: dichiarante needs the procedure's dichiarante");
    }
    for (const ref of Array.isArray(map.fields) ? (map.fields as string[]) : []) {
      const problem =
        checkUse(ref, true, registry, false) ??
        kindProblem(ref, registry, byRuolo ? "impresa" : "persona") ??
        (byRuolo ? procuraProblem(ref, (map.repeat as { ruolo?: unknown }).ruolo) : null);
      if (problem) problems.push(problem);
    }
  }
  return problems;
}

// A concat joins one address's parts, so from one place only. A fallback may
// go from a person's domicilio to their residenza, if its notes say the whole
// address comes from the same one (each row falls back on its own, so a
// domicilio without an interno would get the residenza's), or its template
// reads the parts as {.field}, from the place it picked (checkRowExtras
// refuses any other place in it); never between a person's home and the
// business's premises or registered office.
function addressProblem(map: Record<string, unknown>, notes?: string): string | null {
  const places = (refs: unknown) => [...new Set((Array.isArray(refs) ? refs : []).flatMap((ref) => placeOf(String(ref)) ?? []))];
  const joined = places(map.concat);
  if (joined.length > 1) return `concat joins ${joined.join(" and ")}: an address's parts come from one place`;
  const fallen = places(map.fallback);
  if (fallen.length < 2) return null;
  if (!fallen.every((p) => HOMES.has(splitCopy(p).base))) return `fallback mixes ${fallen.join(" and ")}: an address is a person's home or the business's, never a field from each`;
  if (notes?.trim() || typeof map.template === "string") return null;
  return `fallback from ${fallen.join(" to ")} needs notes saying the whole address comes from the same one`;
}

// Where a ref may appear: *: (each person) only in a repeat row, where every
// field must be the row person's; a named slug nowhere. With a dichiarante,
// an unprefixed field of a person's own data is the dichiarante's.
function checkUse(ref: string, inRow: boolean, registry: Registry, dichiarante: boolean): string | null {
  const { member, local } = splitMember(ref);
  const problem = !member && dichiarante && isPersonData(local, registry) ? checkDichiaranteRef(ref, registry) : checkFieldRef(ref, registry);
  if (problem) return problem;
  if (member === "*") return inRow ? null : `${ref}: *: means each person of a repeat row, which only repeat can fill`;
  if (member) return namesMember(ref, member);
  return inRow ? `${ref}: each row is filled from that person's fields, written *:category.field` : null;
}

// Inside party, fields are read from the person with that ruolo, who is in a
// business vault: never a prefix, and nothing only the owner or a personal
// vault has.
function checkPartyRef(ref: string, registry: Registry): string | null {
  const { member } = splitMember(ref);
  if (member) return `${ref}: inside party, write the field without a prefix; it is read from the person with that ruolo`;
  return checkFieldRef(ref, registry, "the person with that ruolo") ?? kindProblem(ref, registry, "impresa");
}

// A person picked by ruolo can be read for a procura only if every ruolo that
// picks them is one that gives the business a procura (GIVES_PROCURA).
function procuraProblem(ref: string, ruolo: unknown): string | null {
  if (categoryOf(ref) !== "procura") return null;
  const others = (Array.isArray(ruolo) ? ruolo : [ruolo]).filter((r) => !GIVES_PROCURA.has(r as string));
  if (others.length === 0) return null;
  return `${ref}: procura is one a person gave the business, as a client does, so read it from ruolo ${[...GIVES_PROCURA].join(", ")}, not ${others.join(", ")}`;
}

// The dichiarante is the owner of a personal vault or a person with a ruolo in
// a business vault, so their field must be one at least one of those can have.
function checkDichiaranteRef(ref: string, registry: Registry): string | null {
  const asOwner = checkFieldRef(ref, registry);
  if (!asOwner) return null;
  const asPerson = checkFieldRef(ref, registry, "the dichiarante") ?? kindProblem(ref, registry, "impresa");
  if (!asPerson) return null;
  return asOwner === asPerson
    ? asOwner
    : `${ref}: no dichiarante can have it, neither the owner of a personal vault nor a person with a ruolo in a business vault`;
}

const registryCategory = (ref: string, registry: Registry) => registry.categories.find((c) => c.name === categoryOf(ref));

// A person's own data, which a procedure's dichiarante supplies: categories
// about a person that each person has (identity, residenza, cie...), and ruolo.
function isPersonData(local: string, registry: Registry): boolean {
  const category = registryCategory(local, registry);
  return !!category && category.scope === "person" && (category.subject === "persona" || category.name === "ruolo");
}

// People with a ruolo are in a business vault and family members in a
// personal one, so neither can have what only the other kind of vault keeps.
function kindProblem(ref: string, registry: Registry, kind: "persona" | "impresa"): string | null {
  const category = registryCategory(ref, registry);
  const field = category?.fields.find((f) => f.id === canonicalLocal(ref));
  const what = category?.kinds && !category.kinds.includes(kind) ? category.name : field?.kinds && !field.kinds.includes(kind) ? field.id : null;
  if (!what) return null;
  return kind === "impresa"
    ? `${ref}: ${what} is only in personal vaults, and people with a ruolo are in a business vault`
    : `${ref}: ${what} is only in business vaults, and family members are in a personal vault`;
}

// Slugs are chosen per vault (and are often first names), so a procedure
// can't name one.
function namesMember(ref: string, member: string): string {
  return `${ref}: a procedure can't name a particular person ("${member}"); use *: inside repeat, or party`;
}

// A category written with a number from 2 (locale2) is the vault's numbered
// copy of that category: the same fields and rules, for a second premises or
// document. Anything else is the category as written.
export function splitCopy(category: string): { base: string; copy: boolean } {
  const m = /^([a-z_]+?)([2-9]|[1-9][0-9]+)$/.exec(category);
  return m ? { base: m[1], copy: true } : { base: category, copy: false };
}

// The registry category a ref reads, a numbered copy's original included:
// "*:locale2.indirizzo" gives "locale".
function categoryOf(ref: string): string {
  return splitCopy(splitMember(ref).local.split(".")[0]).base;
}

// A ref's field ID without its person, as the registry lists it:
// "leo:cie2.numero" gives "cie.numero".
function canonicalLocal(ref: string): string {
  const field = splitMember(ref).local.split(".").slice(1).join(".");
  return `${categoryOf(ref)}.${field}`;
}

// "leo:cie.numero" gives "leo" and "cie.numero"; an owner's field has no member.
// As in the vault, only a ':' before the first '.' starts a prefix.
export function splitMember(ref: string): { member: string; local: string } {
  const colon = ref.indexOf(":");
  const dot = ref.indexOf(".");
  if (colon < 0 || (dot >= 0 && dot < colon)) return { member: "", local: ref };
  return { member: ref.slice(0, colon), local: ref.slice(colon + 1) };
}

// person: who an unprefixed ref is read from when it may not be the vault's
// owner ("the dichiarante"); their member-only fields are fine, the owner's not.
export function checkFieldRef(ref: string, registry: Registry, person?: string): string | null {
  const { member, local } = splitMember(ref);
  const [written, field] = local.split(".", 2);
  const { base: cat, copy } = splitCopy(written);
  const id = `${cat}.${field}`;
  const secret = `${ref} can't be used in a public procedure: it is (or includes) a secret or payment field`;
  if (registry.forbidden.categories.includes(cat) || registry.forbidden.fields.includes(id)) return secret;
  if (member === "io") return `${ref}: "io" is reserved for the vault's owner, whose fields have no prefix`;
  if (local !== ref && member !== "*" && !MEMBER_SLUG.test(member)) {
    return `${ref}: invalid member "${member}": lower-case letters, digits and hyphens, starting with a letter (at most 32)`;
  }

  const category = registry.categories.find((c) => c.name === cat);
  if (!category) return `unknown category "${written}"`;
  if (copy && category.one_only) return `${ref}: ${cat} has no numbered copies, each person has one; use ${cat}.${field}`;
  if (member && category.scope === "owner") {
    return `${ref}: ${cat} is the vault owner's (the household's), not each member's; drop the "${member}:" prefix`;
  }
  if (person && category.scope === "owner") return `${ref}: ${cat} is the vault owner's (the household's); ${person} can't have it`;

  if (field === "*") {
    // A wildcard must not sweep in a secret field of the category.
    if (registry.forbidden.fields.some((f) => f.startsWith(`${cat}.`))) return secret;
    if (category.open) return `${ref}: a wildcard over an open category could include anything, secrets too; name the fields`;
    // ...nor be all fields its holder can never have.
    const all = (forWhom: string) => category.fields.length > 0 && category.fields.every((f) => f.for === forWhom);
    if (!member && !person && all("member")) return `${ref}: every ${cat} field is another person's, never the vault owner's`;
    if ((member || person) && all("owner")) return `${ref}: every ${cat} field is the vault owner's only`;
    return null;
  }
  if (isCredentialName(field, registry)) return secret;

  if (category.open) return null;
  const known = category.fields.find((f) => f.id === id);
  if (!known) return `unknown field "${local}" (add it to the registry, or use { ask: ... })`;
  if (member && known.for === "owner") return `${ref}: ${local} is the vault owner's field only; drop the "${member}:" prefix`;
  if (person && known.for === "owner") return `${ref}: ${local} is the vault owner's field only; ${person} can't have it`;
  if (!member && !person && known.for === "member") return `${ref} is another person's field, never the vault owner's`;
  return null;
}

function walk(value: unknown, p: string, visit: (p: string, value: unknown, parent: unknown) => void, parent?: unknown) {
  visit(p, value, parent);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${p}/${i}`, visit, value));
  } else if (value && typeof value === "object") {
    for (const [k, item] of Object.entries(value)) walk(item, `${p}/${k}`, visit, value);
  }
}

// --- Whole library ---

export interface FileResult {
  rel: string; // path relative to the procedures directory
  errors: string[];
  doc?: unknown; // the parsed procedure, when the file could be read and parsed
}

// Parses a procedure file's text the way the library reads it: without a
// byte-order mark, as YAML 1.2, refusing a %YAML directive (1.1 would turn
// dates into Date objects and "no" into false). Throws with the message to report.
export function parseProcedure(text: string): unknown {
  // A byte-order mark would hide a %YAML directive from the check below.
  const clean = text.replace(/^\uFEFF/, "");
  if (/^%YAML/m.test(clean)) throw new Error("remove the %YAML directive: procedures are read as YAML 1.2");
  try {
    return parse(clean, { version: "1.2" });
  } catch (e) {
    throw new Error(`not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
}

// Validates every .yaml/.yml file under dir (the procedures root: ids are
// relative to it). With `only`, just the files under that path are reported,
// but ids and related links are still resolved against the whole library.
// A file that can't be read or parsed is reported, not thrown, so one bad file
// doesn't hide the others.
export function validateDir(dir: string, registry: Registry, today: string, only?: string): FileResult[] {
  if (!existsDir(dir)) throw new Error(`procedures directory not found: ${dir}`);
  const files = listYaml(dir);
  const idOf = (file: string) => procedureIdFromPath(path.relative(dir, file));
  const knownIds = new Set(files.map(idOf));
  const ctx: Context = { registry, knownIds, today, offices: officeFields(path.join(path.dirname(dir), "offices")) };
  const sameId = new Map<string, string[]>();
  for (const file of files) sameId.set(idOf(file), [...(sameId.get(idOf(file)) ?? []), path.relative(dir, file)]);
  const inScope = (file: string) => !only || file === only || file.startsWith(only + path.sep);

  return files.filter(inScope).map((file) => {
    const rel = path.relative(dir, file);
    const twins = sameId.get(idOf(file))!.filter((r) => r !== rel);
    if (twins.length) return { rel, errors: [`another file has the same id: ${twins.join(", ")}`] };
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      return { rel, errors: [`can't read file: ${(e as Error).message}`] };
    }
    let doc: unknown;
    try {
      doc = parseProcedure(text);
    } catch (e) {
      return { rel, errors: [(e as Error).message] };
    }
    const errors = validateProcedure(doc, rel, ctx);
    // Comments aren't parsed values, so check them as raw text too.
    text.split(/\r\n|\r|\n/).forEach((line, i) => {
      const comment = line.match(/(?:^|\s)#(.*)$/);
      if (!comment) return;
      for (const what of new Set(findPersonalData(comment[1]))) {
        errors.push(`line ${i + 1}: comment looks like it has a ${what}; procedures must not contain personal data`);
      }
    });
    return { rel, errors, doc };
  });
}

function existsDir(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

// Follows symlinked directories (once each); a broken symlink named *.yaml is
// listed so the read error is reported for it.
function listYaml(dir: string): string[] {
  return listFiles(dir, /\.ya?ml$/i);
}

function listFiles(dir: string, name: RegExp, seen = new Set<string>()): string[] {
  const real = realpathSync(dir);
  if (seen.has(real)) return [];
  seen.add(real);
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        isDir = false; // broken link
      }
    }
    if (isDir) out.push(...listFiles(full, name, seen));
    else if (name.test(entry.name)) out.push(full);
  }
  return out.sort();
}

// --- Situations ---

const checkSituation = ajv.compile(JSON.parse(readFileSync(path.join(ROOT, "contract", "situation.schema.json"), "utf8")));

// Validates every situation under dir (situations/): the schema, its id as
// its file name, steps pointing at procedures in the library (each once),
// dates, and no personal data. A missing directory means no situations.
export function validateSituations(dir: string, knownIds: Set<string>, today: string): FileResult[] {
  if (!existsDir(dir)) return [];
  return listYaml(dir).map((file) => {
    const rel = path.relative(dir, file);
    let doc: unknown;
    try {
      doc = parseProcedure(readFileSync(file, "utf8"));
    } catch (e) {
      return { rel, errors: [(e as Error).message] };
    }
    if (!checkSituation(doc)) {
      return { rel, errors: (checkSituation.errors ?? []).map((e) => `schema: ${e.instancePath || "/"} ${e.message}`) };
    }
    const s = doc as { id: string; updated: string; steps: { procedure: string }[] };
    const errors: string[] = [];
    const expected = rel.replace(/\\/g, "/").replace(/\.ya?ml$/i, "");
    if (s.id !== expected) errors.push(`id "${s.id}" must match its file name "${expected}"`);
    if (s.updated > today) errors.push("updated is in the future");
    const seen = new Set<string>();
    for (const step of s.steps) {
      if (!knownIds.has(step.procedure)) errors.push(`step "${step.procedure}" is not a procedure in the library`);
      if (seen.has(step.procedure)) errors.push(`step "${step.procedure}" is listed twice`);
      seen.add(step.procedure);
    }
    walk(doc, "", (p, value) => {
      if (typeof value !== "string") return;
      for (const what of new Set(findPersonalData(value))) errors.push(`${p}: looks like a ${what}; situations must not contain personal data`);
    });
    return { rel, errors, doc };
  });
}

// --- Offices ---

const checkOfficesSchema = ajv.compile(JSON.parse(readFileSync(path.join(ROOT, "contract", "offices.schema.json"), "utf8")));
// Every value a vault field can take, so each person has an office.
const OFFICE_KEYS: Record<string, string[]> = {
  municipalita: ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"],
  distretto_asl: ["24/73", "25", "26", "27", "28", "29", "30", "31", "32", "33"],
};
// The fields with a valid offices file under dir: the ones a desk channel's
// office may name.
export function officeFields(dir: string): Set<string> {
  return new Set(validateOffices(dir).filter((r) => !r.errors.length).map((r) => path.basename(r.rel, ".json")));
}

// Validates offices/<field>.json: the schema, an office for every value of the
// field, and sources that exist.
export function validateOffices(dir: string): FileResult[] {
  if (!existsDir(dir)) return [];
  return listFiles(dir, /\.json$/i).map((file) => {
    const rel = path.relative(dir, file);
    let doc: { field: string; offices: Record<string, { source: string }>; sources: { id: string }[] };
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      return { rel, errors: [`not valid JSON: ${(e as Error).message}`] };
    }
    if (!checkOfficesSchema(doc)) {
      return { rel, errors: (checkOfficesSchema.errors ?? []).map((e) => `schema: ${e.instancePath || "/"} ${e.message}`) };
    }
    const errors: string[] = [];
    if (path.basename(file, ".json") !== doc.field) errors.push(`field ${doc.field}: the file is offices/${doc.field}.json`);
    const want = OFFICE_KEYS[doc.field] ?? [];
    for (const k of want) if (!doc.offices[k]) errors.push(`no office for ${doc.field} ${k}`);
    for (const k of Object.keys(doc.offices)) if (!want.includes(k)) errors.push(`${k} isn't a ${doc.field}`);
    const ids = new Set(doc.sources.map((x) => x.id));
    for (const [k, o] of Object.entries(doc.offices)) if (!ids.has(o.source)) errors.push(`offices/${k}: unknown source ${o.source}`);
    return { rel, errors, doc };
  });
}

// --- Layouts ---

const checkLayoutSchema = ajv.compile(JSON.parse(readFileSync(path.join(ROOT, "contract", "layout.schema.json"), "utf8")));

type Rect = number[];
interface LayoutBox {
  label: string;
  page?: number;
  rect?: Rect;
  widget?: string;
  continuation?: (Rect | { page: number; rect: Rect })[];
  cells?: number[][];
  baseline?: number;
  parts?: Rect[];
  choices?: Record<string, Rect>;
  choice_widgets?: Record<string, string>;
  write?: Record<string, Rect | string>;
  partial?: boolean;
  table?: { rows: number[][]; columns: Record<string, number[]> };
  into_table?: string;
  skip?: string;
}
interface Layout {
  procedure: string;
  form: string;
  sha256: string;
  boxes: LayoutBox[];
  signatures?: { rect?: unknown; date_rect?: unknown }[];
  unmapped?: { box: string; needed_when?: { field: string; box: string } }[];
}

const BOX_KINDS = ["rect", "widget", "cells", "parts", "choices", "choice_widgets", "table", "into_table", "skip"] as const;

// Validates every layout under dir (layouts/<procedure id>/<form id>.json)
// against the procedures it places: the form exists at that sha256, and
// every field of it has exactly one box of the right kind.
export function validateLayouts(dir: string, procedures: FileResult[]): FileResult[] {
  if (!existsDir(dir)) return [];
  const byId = new Map(procedures.filter((r) => r.doc).map((r) => [procedureIdFromPath(r.rel), r.doc as Doc]));
  return listFiles(dir, /\.json$/i).map((file) => {
    const rel = path.relative(dir, file);
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      return { rel, errors: [`not valid JSON: ${(e as Error).message}`] };
    }
    if (!checkLayoutSchema(doc)) {
      return { rel, errors: (checkLayoutSchema.errors ?? []).map((e) => `schema: ${e.instancePath || "/"} ${e.message}`) };
    }
    const l = doc as Layout;
    const errors: string[] = [];
    const expected = rel.replace(/\\/g, "/").replace(/\.json$/i, "");
    if (`${l.procedure}/${l.form}` !== expected) errors.push(`procedure and form "${l.procedure}/${l.form}" must match its path "${expected}"`);
    const form = byId.get(l.procedure)?.forms?.find((f) => f.id === l.form);
    if (!byId.has(l.procedure)) errors.push(`no procedure ${l.procedure}`);
    else if (!form) errors.push(`${l.procedure} has no form ${l.form}`);
    if (!form) return { rel, errors, doc };
    if (!form.sha256) errors.push(`form ${l.form} has no sha256, so a layout can't be tied to a version of it`);
    else if (form.sha256 !== l.sha256) errors.push(`sha256 isn't the form's (${form.sha256.slice(0, 12)}...): the form changed, so measure it again`);

    if (l.signatures && !form.signature_required) errors.push(`signatures place a signature, but form ${l.form} has no signature_required: true`);
    // The vault stamps the image into each box and refuses one it can't use.
    (l.signatures ?? []).forEach((sig, i) => {
      for (const key of ["rect", "date_rect"] as const) {
        const r = sig[key];
        if (!Array.isArray(r) || r.length !== 4 || !r.every((n) => typeof n === "number")) continue;
        const [x0, top, x1, bottom] = r as number[];
        if (!(x0 < x1 && top < bottom)) errors.push(`signatures/${i}/${key}: must be [x0, top, x1, bottom] with x0 < x1 and top < bottom`);
        else if (x1 - x0 < 20 || bottom - top < 10) errors.push(`signatures/${i}/${key}: is ${x1 - x0} x ${bottom - top} points; the vault needs at least 20 x 10`);
      }
    });

    const rows = new Map((form.fields ?? []).map((r) => [r.label, r]));
    const placed = new Set<string>();
    for (const box of l.boxes) {
      const row = rows.get(box.label);
      if (!row) {
        errors.push(`box "${box.label}" is no field of the form`);
        continue;
      }
      if (placed.has(box.label)) errors.push(`"${box.label}" is placed twice`);
      placed.add(box.label);
      errors.push(...boxProblems(box, row, l.boxes, form.fields ?? []).map((p) => `"${box.label}": ${p}`));
    }
    for (const label of rows.keys()) if (!placed.has(label)) errors.push(`field "${label}" has no box`);
    for (const u of l.unmapped ?? []) {
      const w = u.needed_when;
      if (w && !rows.get(w.field)?.choices?.some((c) => c.box === w.box)) {
        errors.push(`unmapped "${u.box}": needed_when names no box "${w.box}" of field "${w.field}"`);
      }
    }
    return { rel, errors, doc };
  });
}

function boxProblems(box: LayoutBox, row: Row, boxes: LayoutBox[], rows: Row[]): string[] {
  const out: string[] = [];
  const kinds = BOX_KINDS.filter((k) => box[k] !== undefined);
  if (kinds.length !== 1) return [`give exactly one of ${BOX_KINDS.join(", ")}`];
  const kind = kinds[0];
  const m = row.map;
  if (box.cells && box.baseline === undefined) out.push("cells need a baseline");
  if (box.baseline !== undefined && !box.cells) out.push("a baseline is for cells");
  if (box.continuation && kind !== "rect") out.push("continuation lines follow a rect");
  if (box.write && kind !== "choices" && kind !== "choice_widgets") out.push("write is for boxes to tick");
  // Drawn boxes are written next to in a rect, fillable ones in a text field.
  const named = kind === "choice_widgets";
  for (const [b, place] of Object.entries(box.write ?? {})) {
    if (named !== (typeof place === "string")) out.push(`write "${b}": ${named ? "name the form's text field" : "give a rect"}, as the boxes are`);
  }
  // An ask other rows' when depends on may have no box: a question only.
  const gate = m.ask !== undefined && rows.some((r) => r.when?.field === box.label);
  if (row.choices && !(kind === "skip" && gate)) {
    if (kind !== "choices" && kind !== "choice_widgets") return [...out, "the field is boxes to tick: place each under choices or choice_widgets"];
    const want = row.choices.map((c) => c.box).sort();
    const got = Object.keys(box[kind]!).sort();
    if (want.join("\n") !== got.join("\n")) out.push(`choices must be the field's boxes: ${want.join(", ")}`);
    const writes = row.choices.filter((c) => c.write_value).map((c) => c.box).sort();
    if (writes.join("\n") !== Object.keys(box.write ?? {}).sort().join("\n")) out.push(`write must place exactly the boxes with write_value: ${writes.join(", ") || "none"}`);
  } else if (kind === "choices" || kind === "choice_widgets") {
    out.push("the field has no choices");
  }
  // A repeat by ruolo without columns is one allegato per person: its box is
  // placed once, and a consumer fills a copy of its pages for each person.
  const allegato = typeof m.repeat === "object" && m.repeat !== null && !Array.isArray(m.columns);
  if (m.repeat !== undefined && !allegato) {
    if (kind !== "table") return [...out, "a repeat field is a table"];
    const columns = Array.isArray(m.columns) ? (m.columns as { label: string }[]).map((c) => c.label).sort() : [];
    if (!columns.length) out.push("the field gives no columns to place");
    else if (columns.join("\n") !== Object.keys(box.table!.columns).sort().join("\n")) out.push(`columns must be the field's: ${columns.join(", ")}`);
  } else if (kind === "table") {
    out.push("only a repeat field is a table");
  }
  if (kind === "into_table") {
    if (m.ask === undefined) out.push("only an ask's answers go into another field's table");
    if (!boxes.find((b) => b.label === box.into_table)?.table) out.push(`"${box.into_table}" is no table on this form`);
  }
  if (kind === "skip" && m.blank_with_reason === undefined && !gate) {
    out.push("only a blank_with_reason field, or an ask a when depends on, is skipped");
  }
  if (box.partial && kind !== "cells") out.push("partial is for cells");
  return out;
}
