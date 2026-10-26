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
const ASKS_FOR_SECRET = /\b(pin(?!\s*\d)|puk|password|passcode|otp|codice segreto)\b/i;
// The ruoli that give a business a procura (the procura category): a client,
// so the business can act for them. A procuratore holds the business's procura,
// the other way round. Listed, not excluded, so a new ruolo stays refused.
const GIVES_PROCURA = new Set(["cliente"]);

export interface Context {
  registry: Registry;
  // ids of every procedure in the library (from file paths), for `related`
  knownIds: Set<string>;
  today: string; // YYYY-MM-DD
}

// Procedure documents are plain YAML data; this is the subset the checks read.
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
  channels?: { purpose?: string; preferred?: boolean }[];
  deadline?: { summary?: unknown; rules?: unknown[] };
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
  forms?: { id: string; fields?: { label: string; map: Record<string, unknown>; notes?: string }[] }[];
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
    for (const field of f.fields ?? []) {
      for (const problem of checkMapping(field.map, ctx.registry, d.dichiarante !== undefined, field.notes)) {
        errors.push(`form "${f.id}", field "${field.label}": ${problem}`);
      }
    }
  }

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
      ...(d.forms ?? []).flatMap((f) => (f.fields ?? []).flatMap((x) => (x.map.party ? [] : directRefs(x.map)))),
      ...(d.records ?? []).map((r) => r.field),
    ].filter((ref) => !splitMember(ref).member);
    const isBusiness = (ref: string) => /^(business|locale)\./.test(ref);
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

// The places an address can come from: a person's residenza or domicilio,
// the business's premises (locale) or its registered office. An address is
// taken whole from one of them (see addressProblem).
const HOMES = new Set(["residenza", "domicilio"]);
function placeOf(ref: string): string | undefined {
  const local = splitMember(ref).local;
  const category = local.split(".")[0];
  if (HOMES.has(category) || category === "locale") return category;
  return local.startsWith("business.sede_legale_") ? "sede legale" : undefined;
}

// dichiarante: the procedure names who signs, so a person's own data is theirs.
function checkMapping(map: Record<string, unknown>, registry: Registry, dichiarante: boolean, notes?: string): string[] {
  const problems: string[] = [];
  const refs = directRefs(map);
  const address = addressProblem(map, notes);
  if (address) problems.push(address);

  for (const key of ["ask", "blank_with_reason"]) {
    if (typeof map[key] === "string" && ASKS_FOR_SECRET.test(map[key] as string)) {
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
// domicilio without an interno would get the residenza's); never between a
// person's home and the business's premises or registered office.
function addressProblem(map: Record<string, unknown>, notes?: string): string | null {
  const places = (refs: unknown) => [...new Set((Array.isArray(refs) ? refs : []).flatMap((ref) => placeOf(String(ref)) ?? []))];
  const joined = places(map.concat);
  if (joined.length > 1) return `concat joins ${joined.join(" and ")}: an address's parts come from one place`;
  const fallen = places(map.fallback);
  if (fallen.length < 2) return null;
  if (!fallen.every((p) => HOMES.has(p))) return `fallback mixes ${fallen.join(" and ")}: an address is a person's home or the business's, never a field from each`;
  return notes?.trim() ? null : `fallback from ${fallen.join(" to ")} needs notes saying the whole address comes from the same one`;
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
  if (splitMember(ref).local.split(".")[0] !== "procura") return null;
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

const registryCategory = (ref: string, registry: Registry) => registry.categories.find((c) => c.name === ref.split(".")[0]);

// A person's own data, which a procedure's dichiarante supplies: categories
// about a person that each person has (identity, residenza, cie...), and ruolo.
function isPersonData(local: string, registry: Registry): boolean {
  const category = registry.categories.find((c) => c.name === local.split(".")[0]);
  return !!category && category.scope === "person" && (category.subject === "persona" || category.name === "ruolo");
}

// People with a ruolo are in a business vault and family members in a
// personal one, so neither can have what only the other kind of vault keeps.
function kindProblem(ref: string, registry: Registry, kind: "persona" | "impresa"): string | null {
  const { local } = splitMember(ref);
  const category = registry.categories.find((c) => c.name === local.split(".")[0]);
  const field = category?.fields.find((f) => f.id === local);
  const what = category?.kinds && !category.kinds.includes(kind) ? category.name : field?.kinds && !field.kinds.includes(kind) ? local : null;
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
  const [cat, field] = local.split(".", 2);
  const secret = `${ref} can't be used in a public procedure: it is (or includes) a secret or payment field`;
  if (registry.forbidden.categories.includes(cat) || registry.forbidden.fields.includes(local)) return secret;
  if (member === "io") return `${ref}: "io" is reserved for the vault's owner, whose fields have no prefix`;
  if (local !== ref && member !== "*" && !MEMBER_SLUG.test(member)) {
    return `${ref}: invalid member "${member}": lower-case letters, digits and hyphens, starting with a letter (at most 32)`;
  }

  const category = registry.categories.find((c) => c.name === cat);
  if (!category) return `unknown category "${cat}"`;
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
  if (isCredentialName(field, registry.credential_word)) return secret;

  if (category.open) return null;
  const known = category.fields.find((f) => f.id === local);
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
  const ctx: Context = { registry, knownIds, today };
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
function listYaml(dir: string, seen = new Set<string>()): string[] {
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
    if (isDir) out.push(...listYaml(full, seen));
    else if (/\.ya?ml$/i.test(entry.name)) out.push(full);
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
