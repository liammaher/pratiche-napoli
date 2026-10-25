// Generates contract/fields.json from the personal vault's recommended schema
// (`pvault schema --json`). The registry is the shared vocabulary between
// procedures here and any data source that fills them in.
//
// Usage: npm run gen:fields -- <path to schema.json>
//
// Secrets and payment data never belong in a public procedure, so those fields
// are left out of the registry and listed under `forbidden` instead.

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
const FORBIDDEN_SENSITIVITY = new Set(["critical", "personal"]);
const DYNAMIC: Record<string, string> = {
  nucleo_familiare: "membro<N>_<campo>",
  pratiche: "<slug>_<campo>",
};

export function buildRegistry(schema: VaultSchema): Registry {
  const forbiddenFields: string[] = [];
  const categories: Registry["categories"] = [];

  for (const cat of schema.categories) {
    if (FORBIDDEN_CATEGORIES.includes(cat.name)) continue;
    const fields = [];
    for (const f of cat.fields ?? []) {
      if (FORBIDDEN_SENSITIVITY.has(f.sensitivity)) {
        forbiddenFields.push(f.id);
        continue;
      }
      fields.push({ id: f.id, description: f.description });
    }
    const entry: Registry["categories"][number] = {
      name: cat.name,
      description: cat.description,
      fields,
    };
    if (DYNAMIC[cat.name]) entry.dynamic = DYNAMIC[cat.name];
    else if (fields.length === 0) entry.open = true;
    categories.push(entry);
  }

  return {
    version: schema.version,
    source: "personal-vault RecommendedSchema",
    categories,
    forbidden: { categories: FORBIDDEN_CATEGORIES, fields: forbiddenFields.sort() },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const input = process.argv[2];
  if (!input) {
    console.error("usage: npm run gen:fields -- <schema.json from `pvault schema --json`>");
    process.exit(2);
  }
  const schema = JSON.parse(readFileSync(input, "utf8")) as VaultSchema;
  const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "contract", "fields.json");
  writeFileSync(out, JSON.stringify(buildRegistry(schema), null, 2) + "\n");
  console.log(`wrote ${out}`);
}
