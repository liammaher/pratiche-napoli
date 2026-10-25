// Generates contract/fields.json from the personal vault's recommended schema
// (`pvault schema --json`). The registry is the shared vocabulary between
// procedures here and any data source that fills them in.
//
// Usage: npm run gen:fields [-- <path to schema.json>]
// With a path, the schema is first saved as contract/vault-schema.json; without
// one, the registry is rebuilt from that saved copy. A test checks that
// fields.json is exactly what this produces, so it can't be edited by hand.
//
// Secrets and payment-card data never belong in a public procedure, so those
// fields are left out of the registry and listed under `forbidden` instead.
// Anything with a sensitivity tier we don't know is treated as secret.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

interface VaultField {
  id: string;
  description: string;
  sensitivity: string;
}

interface VaultCategory {
  name: string;
  description: string;
  fields: VaultField[] | null;
}

interface VaultSchema {
  version: string;
  categories: VaultCategory[];
}

export interface Registry {
  version: string;
  source: string;
  categories: {
    name: string;
    description: string;
    fields: { id: string; description: string }[];
    // A pattern such as "membro<N>_<campo>": field names are built per item.
    dynamic?: string;
    // No fixed fields: any field name is allowed in this category.
    open?: boolean;
  }[];
  forbidden: { categories: string[]; fields: string[] };
}

const FORBIDDEN_CATEGORIES = ["spid", "payment", "medical"];
// The vault's own tracking of procedures in progress, not form data.
const INTERNAL_CATEGORIES = ["pratiche"];
const ALLOWED_SENSITIVITY = new Set(["public", "standard", "sensitive"]);
const DYNAMIC: Record<string, string> = {
  nucleo_familiare: "membro<N>_<campo>",
};

export function buildRegistry(schema: VaultSchema): Registry {
  if (!schema || typeof schema.version !== "string" || !Array.isArray(schema.categories)) {
    throw new Error("not a vault schema: expected { version, categories: [...] }");
  }
  const forbiddenCategories = [...FORBIDDEN_CATEGORIES];
  const forbiddenFields: string[] = [];
  const categories: Registry["categories"] = [];

  for (const cat of schema.categories) {
    if (FORBIDDEN_CATEGORIES.includes(cat.name) || INTERNAL_CATEGORIES.includes(cat.name)) continue;
    const vaultFields = cat.fields ?? [];
    const fields = [];
    for (const f of vaultFields) {
      if (!f.id.startsWith(`${cat.name}.`)) {
        throw new Error(`field "${f.id}" is listed under category "${cat.name}"`);
      }
      if (!ALLOWED_SENSITIVITY.has(f.sensitivity)) {
        forbiddenFields.push(f.id);
        continue;
      }
      fields.push({ id: f.id, description: f.description });
    }
    // Every field secret: the whole category is, rather than becoming open.
    if (vaultFields.length > 0 && fields.length === 0) {
      forbiddenCategories.push(cat.name);
      continue;
    }
    const entry: Registry["categories"][number] = {
      name: cat.name,
      description: cat.description,
      fields,
    };
    if (DYNAMIC[cat.name]) entry.dynamic = DYNAMIC[cat.name];
    else if (vaultFields.length === 0) entry.open = true;
    categories.push(entry);
  }

  return {
    version: schema.version,
    source: "personal-vault RecommendedSchema",
    categories,
    forbidden: { categories: forbiddenCategories, fields: forbiddenFields.sort() },
  };
}

const CONTRACT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "contract");
export const VAULT_SCHEMA_PATH = path.join(CONTRACT, "vault-schema.json");
export const FIELDS_PATH = path.join(CONTRACT, "fields.json");

export function renderRegistry(schema: VaultSchema): string {
  return JSON.stringify(buildRegistry(schema), null, 2) + "\n";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  const text = readFileSync(input ?? VAULT_SCHEMA_PATH, "utf8");
  const schema = JSON.parse(text) as VaultSchema;
  const registry = renderRegistry(schema); // validates before anything is written
  if (input) writeFileSync(VAULT_SCHEMA_PATH, JSON.stringify(schema, null, 2) + "\n");
  writeFileSync(FIELDS_PATH, registry);
  console.log(`wrote ${FIELDS_PATH}`);
}
