// Checks a procedure against contract/procedure.schema.json and the rules a
// JSON Schema can't express: field IDs exist in the registry and never reach a
// secret, references point somewhere real, verified claims cite an official
// source, dates aren't in the future, and no personal data slipped in.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "yaml";
import type { Registry } from "../gen-fields.ts";
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

// Words that mark a credential in a field name: the vault's reCredentialWord
// (internal/vault/italy.go) plus "token". Unlike the vault, any category counts.
export const CREDENTIAL = /(^|_)(pin\d*|puk\d*|password|passwd|pwd|pw|pass|passcode|otp|totp|username|login|secret|segreto|chiave|token)(_|$)/;
// A family member's slug, as the vault's reMemberSlug; "io" is reserved.
const MEMBER_SLUG = /^[a-z][a-z0-9-]{0,31}$/;
// The same secrets named in an ask or blank_with_reason text. "PIN 2.1" etc.
// are the Vigili del Fuoco form names, not PIN codes.
const ASKS_FOR_SECRET = /\b(pin(?!\s*\d)|puk|password|passcode|otp|codice segreto)\b/i;

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
  sources?: Source[];
  forms?: { id: string; fields?: { label: string; map: Record<string, unknown> }[] }[];
  records?: { field: string }[];
  related?: string[];
  run_log?: { date: string }[];
  verification?: { level?: string; date?: string };
  [key: string]: unknown;
}

export function validateProcedure(doc: unknown, relPath: string, ctx: Context): string[] {
  const errors: string[] = [];
  if (!checkSchema(doc)) {
    // A field mapping that matches no branch makes ajv report every branch;
    // replace all of that with one message.
    const all = checkSchema.errors ?? [];
    const badMaps = all
      .filter((e) => e.keyword === "oneOf" && e.instancePath.endsWith("/map"))
      .map((e) => e.instancePath);
    for (const e of all) {
      const inBadMap = badMaps.some((p) => e.instancePath === p || e.instancePath.startsWith(`${p}/`));
      if (inBadMap && e.keyword !== "oneOf") continue;
      const message = inBadMap
        ? "must be exactly one of direct, concat (2+), fallback (2+), repeat: famiglia with fields, " +
          "blank_with_reason or ask, with field IDs like identity.email"
        : e.message;
      errors.push(`schema: ${e.instancePath || "/"} ${message}`);
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
      for (const problem of checkMapping(field.map, ctx.registry)) {
        errors.push(`form "${f.id}", field "${field.label}": ${problem}`);
      }
    }
  }

  const recorded = new Set<string>();
  for (const r of d.records ?? []) {
    if (recorded.has(r.field)) errors.push(`records: "${r.field}" is listed twice`);
    recorded.add(r.field);
    const problem = checkFieldRef(r.field, ctx.registry);
    if (problem) errors.push(`records: ${problem}`);
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

  for (const r of d.related ?? []) {
    if (r === d.id) errors.push("a procedure can't be related to itself");
    else if (!ctx.knownIds.has(r)) errors.push(`related "${r}" is not a procedure in the library`);
  }

  for (const entry of d.run_log ?? []) {
    if (entry.date > ctx.today) errors.push(`run_log entry dated ${entry.date} is in the future`);
  }

  const v = d.verification ?? {};
  if (v.date && v.date > ctx.today) errors.push("verification date is in the future");
  if (v.level && v.level !== "L0" && !(d.sources ?? []).some((s) => s.official && s.url)) {
    errors.push(`level ${v.level} needs at least one official source with a URL`);
  }

  return errors;
}

export function procedureIdFromPath(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^procedures\//, "").replace(/\.ya?ml$/i, "");
}

function checkMapping(map: Record<string, unknown>, registry: Registry): string[] {
  const problems: string[] = [];
  const refs: string[] = [];
  if (typeof map.direct === "string") refs.push(map.direct);
  for (const key of ["concat", "fallback"]) if (Array.isArray(map[key])) refs.push(...(map[key] as string[]));

  for (const key of ["ask", "blank_with_reason"]) {
    if (typeof map[key] === "string" && ASKS_FOR_SECRET.test(map[key] as string)) {
      problems.push(`${key} must not ask for a PIN, password or other secret`);
    }
  }
  for (const ref of refs) {
    const problem = checkUse(ref, false, registry);
    if (problem) problems.push(problem);
  }
  // repeat: famiglia fills one row per member, from that member's fields.
  for (const ref of Array.isArray(map.fields) ? (map.fields as string[]) : []) {
    const problem = checkUse(ref, true, registry);
    if (problem) problems.push(problem);
  }
  return problems;
}

// Where a ref may appear: *: (each member) only in a repeat: famiglia row,
// where every field must be the row member's; a named slug nowhere.
function checkUse(ref: string, inRow: boolean, registry: Registry): string | null {
  const problem = checkFieldRef(ref, registry);
  if (problem) return problem;
  const { member } = splitMember(ref);
  if (member === "*") return inRow ? null : `${ref}: *: means each family member, which only repeat: famiglia can fill`;
  if (member) return namesMember(ref, member);
  return inRow ? `${ref}: each row is filled from that member's fields, written *:category.field` : null;
}

// Slugs are chosen per vault (and are often first names), so a procedure
// can't name one.
function namesMember(ref: string, member: string): string {
  return `${ref}: a procedure can't name a particular family member ("${member}"); use *: inside repeat: famiglia`;
}

// "leo:cie.numero" gives "leo" and "cie.numero"; an owner's field has no member.
// As in the vault, only a ':' before the first '.' starts a prefix.
export function splitMember(ref: string): { member: string; local: string } {
  const colon = ref.indexOf(":");
  const dot = ref.indexOf(".");
  if (colon < 0 || (dot >= 0 && dot < colon)) return { member: "", local: ref };
  return { member: ref.slice(0, colon), local: ref.slice(colon + 1) };
}

export function checkFieldRef(ref: string, registry: Registry): string | null {
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

  if (field === "*") {
    // A wildcard must not sweep in a secret field of the category.
    if (registry.forbidden.fields.some((f) => f.startsWith(`${cat}.`))) return secret;
    return category.open ? `${ref}: a wildcard over an open category could include anything, secrets too; name the fields` : null;
  }
  if (CREDENTIAL.test(field)) return secret;

  if (category.open) return null;
  const known = category.fields.find((f) => f.id === local);
  if (!known) return `unknown field "${local}" (add it to the registry, or use { ask: ... })`;
  if (member && known.for === "owner") return `${ref}: ${local} is the vault owner's field only; drop the "${member}:" prefix`;
  if (!member && known.for === "member") return `${ref} is a family member's field, never the vault owner's`;
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
      // A byte-order mark would hide a %YAML directive from the check below.
      text = readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    } catch (e) {
      return { rel, errors: [`can't read file: ${(e as Error).message}`] };
    }
    // A %YAML 1.1 directive would turn dates into Date objects and "no" into false.
    if (/^%YAML/m.test(text)) {
      return { rel, errors: ["remove the %YAML directive: procedures are read as YAML 1.2"] };
    }
    let doc: unknown;
    try {
      doc = parse(text, { version: "1.2" });
    } catch (e) {
      return { rel, errors: [`not valid YAML: ${(e as Error).message.split("\n")[0]}`] };
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
    return { rel, errors };
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
