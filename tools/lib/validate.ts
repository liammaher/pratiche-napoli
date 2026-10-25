// Checks a procedure against contract/procedure.schema.json and the rules a
// JSON Schema can't express: field IDs exist in the registry and never reach a
// secret, references point somewhere real, verified claims cite an official
// source, dates aren't in the future, and no personal data slipped in.

import { readdirSync, readFileSync, statSync } from "node:fs";
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

// Words that mark a credential in a field name, as the vault's IsCredentialField does.
const CREDENTIAL = /(^|_)(pin|puk|password|passwd|otp|secret|token)(_|$)/;

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
        ? "must be exactly one of direct, concat (2+), fallback (2+), repeat, blank_with_reason or ask, " +
          "with field IDs like identity.email"
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
  for (const key of ["direct", "repeat"]) if (typeof map[key] === "string") refs.push(map[key] as string);
  for (const key of ["concat", "fallback"]) if (Array.isArray(map[key])) refs.push(...(map[key] as string[]));

  if ("repeat" in map && !refs[0].includes("<N>")) {
    problems.push(`repeat needs a per-item pattern such as nucleo_familiare.membro<N>_*`);
  }
  for (const ref of refs) {
    if (ref.includes("<N>") && !("repeat" in map)) {
      problems.push(`${ref}: "<N>" patterns can only be used with repeat`);
      continue;
    }
    const problem = checkFieldRef(ref, registry);
    if (problem) problems.push(problem);
  }
  return problems;
}

export function checkFieldRef(ref: string, registry: Registry): string | null {
  const [cat, field] = ref.split(".", 2);
  const secret = `${ref} can't be used in a public procedure: it is (or includes) a secret or payment field`;
  if (registry.forbidden.categories.includes(cat) || registry.forbidden.fields.includes(ref)) return secret;

  const category = registry.categories.find((c) => c.name === cat);
  if (!category) return `unknown category "${cat}"`;

  if (field === "*" || field.includes("<N>")) {
    // A wildcard or pattern must not sweep in a secret field of the category.
    if (registry.forbidden.fields.some((f) => f.startsWith(`${cat}.`))) return secret;
  }
  if (field === "*") return null;
  if (CREDENTIAL.test(field.replace(/\*$/, ""))) return secret;

  if (category.dynamic) {
    if (category.fields.some((f) => f.id === ref)) return null;
    return templateMatches(category.dynamic, field)
      ? null
      : `${ref} doesn't follow the pattern ${cat}.${category.dynamic}`;
  }
  if (field.includes("<N>")) return `${cat} has no per-item fields; "<N>" can't be used`;
  if (category.open) return null;
  if (category.fields.some((f) => f.id === ref)) return null;
  return `unknown field "${ref}" (add it to the registry, or use { ask: ... })`;
}

// "membro<N>_<campo>" accepts membro<N>_*, membro<N>_nome and membro2_nome.
function templateMatches(template: string, field: string): boolean {
  const re = template
    .split(/(<N>|<campo>)/)
    .map((part) => (part === "<N>" ? "(?:<N>|[1-9][0-9]*)" : part === "<campo>" ? "(?:[a-z0-9_]+|\\*)" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${re}$`).test(field);
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

// Validates every .yaml/.yml file under dir. A file that isn't valid YAML is
// reported, not thrown, so one bad file doesn't hide the others.
export function validateDir(dir: string, registry: Registry, today: string): FileResult[] {
  if (!existsDir(dir)) throw new Error(`procedures directory not found: ${dir}`);
  const files = listYaml(dir);
  const knownIds = new Set(files.map((file) => procedureIdFromPath(path.relative(dir, file))));
  const ctx: Context = { registry, knownIds, today };

  return files.map((file) => {
    const rel = path.relative(dir, file);
    const text = readFileSync(file, "utf8");
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
    text.split("\n").forEach((line, i) => {
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

function listYaml(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listYaml(full));
    else if (/\.ya?ml$/i.test(entry.name)) out.push(full);
  }
  return out.sort();
}
