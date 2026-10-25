// Checks a procedure against contract/procedure.schema.json and the rules a
// JSON Schema can't express: field IDs exist in the registry, references point
// somewhere real, verified claims cite a source, and no personal data slipped in.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { Registry } from "../gen-fields.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const schema = JSON.parse(readFileSync(path.join(ROOT, "contract", "procedure.schema.json"), "utf8"));
const ajv = new Ajv2020.default({ allErrors: true, strict: true });
addFormats.default(ajv);
const checkSchema = ajv.compile(schema);

export function loadRegistry(): Registry {
  return JSON.parse(readFileSync(path.join(ROOT, "contract", "fields.json"), "utf8"));
}

// Shapes of personal data that must never appear in a shared procedure.
const PERSONAL_PATTERNS: [string, RegExp][] = [
  ["codice fiscale", /\b[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-EHLMPR-T][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]\b/i],
  ["IBAN", /\bIT\d{2}[A-Z]\d{10}[0-9A-Z]{12}\b/i],
];

export interface Context {
  registry: Registry;
  // ids of every procedure in the library, for `related`
  knownIds: Set<string>;
  today: string; // YYYY-MM-DD
}

// Procedure documents are plain YAML data; this is the subset the checks read.
interface Doc {
  id?: string;
  sources?: { id: string; url?: string; official?: boolean; retrieved?: string }[];
  forms?: { id: string; source?: string; fields?: { label: string; map: Record<string, unknown> }[] }[];
  related?: string[];
  verification?: { level?: string; date?: string };
  [key: string]: unknown;
}

export function validateProcedure(doc: unknown, relPath: string, ctx: Context): string[] {
  const errors: string[] = [];
  if (!checkSchema(doc)) {
    // A failed oneOf (a field mapping) reports every branch; keep one message for it.
    const all = checkSchema.errors ?? [];
    const oneOfPaths = new Set(all.filter((e) => e.keyword === "oneOf").map((e) => e.instancePath));
    for (const e of all) {
      if (oneOfPaths.has(e.instancePath) && e.keyword !== "oneOf") continue;
      const message = e.keyword === "oneOf"
        ? "must be exactly one of: direct, concat, fallback, repeat, blank_with_reason, ask"
        : e.message;
      errors.push(`schema: ${e.instancePath || "/"} ${message}`);
    }
    return errors;
  }
  const d = doc as Doc;

  const expectedId = relPath.replace(/\\/g, "/").replace(/^procedures\//, "").replace(/\.ya?ml$/, "");
  if (d.id !== expectedId) errors.push(`id "${d.id}" must match its path "${expectedId}"`);

  const sourceIds = new Set<string>();
  for (const s of d.sources ?? []) {
    if (sourceIds.has(s.id)) errors.push(`duplicate source id "${s.id}"`);
    sourceIds.add(s.id);
    if (s.retrieved && s.retrieved > ctx.today) errors.push(`source "${s.id}" retrieved in the future`);
  }

  const formIds = new Set<string>();
  for (const f of d.forms ?? []) {
    if (formIds.has(f.id)) errors.push(`duplicate form id "${f.id}"`);
    formIds.add(f.id);
    for (const field of f.fields ?? []) {
      for (const ref of fieldRefs(field.map)) {
        const problem = checkFieldRef(ref, ctx.registry);
        if (problem) errors.push(`form "${f.id}", field "${field.label}": ${problem}`);
      }
    }
  }

  walk(d, "", (p, value, parent) => {
    if (typeof value === "string") {
      for (const [what, re] of PERSONAL_PATTERNS) {
        if (re.test(value)) errors.push(`${p}: looks like a ${what}; procedures must not contain personal data`);
      }
    }
    if (p.endsWith("/source") && typeof value === "string" && !sourceIds.has(value)) {
      errors.push(`${p}: unknown source "${value}"`);
    }
    if (parent && typeof parent === "object" && "status" in parent && p.endsWith("/status")) {
      const claim = parent as { status: string; source?: string };
      if (claim.status === "verified" && !claim.source) {
        errors.push(`${p}: a verified claim must cite a source`);
      }
    }
  });

  for (const r of d.related ?? []) {
    if (!ctx.knownIds.has(r)) errors.push(`related "${r}" is not a procedure in the library`);
  }

  const v = d.verification ?? {};
  if (v.date && v.date > ctx.today) errors.push("verification date is in the future");
  if (v.level && v.level !== "L0" && !(d.sources ?? []).some((s) => s.official && s.url)) {
    errors.push(`level ${v.level} needs at least one official source with a URL`);
  }

  return errors;
}

function fieldRefs(map: Record<string, unknown>): string[] {
  for (const key of ["direct", "repeat"]) {
    if (typeof map[key] === "string") return [map[key] as string];
  }
  for (const key of ["concat", "fallback"]) {
    if (Array.isArray(map[key])) return map[key] as string[];
  }
  return [];
}

export function checkFieldRef(ref: string, registry: Registry): string | null {
  const [cat, field] = ref.split(".", 2);
  if (registry.forbidden.categories.includes(cat) || registry.forbidden.fields.includes(ref)) {
    return `${ref} is a secret or payment field and can't be used in a public procedure`;
  }
  const category = registry.categories.find((c) => c.name === cat);
  if (!category) return `unknown category "${cat}"`;
  if (field === "*") return null;
  if (field.includes("<N>")) {
    return category.dynamic ? null : `${cat} has no per-item fields; "<N>" can't be used`;
  }
  if (category.open) return null;
  if (category.fields.some((f) => f.id === ref)) return null;
  return `unknown field "${ref}" (add it to the registry, or use { ask: ... })`;
}

function walk(value: unknown, p: string, visit: (p: string, value: unknown, parent: unknown) => void, parent?: unknown) {
  visit(p, value, parent);
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${p}/${i}`, visit, value));
  } else if (value && typeof value === "object") {
    for (const [k, item] of Object.entries(value)) walk(item, `${p}/${k}`, visit, value);
  }
}
