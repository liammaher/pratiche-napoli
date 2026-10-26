// Generates contract/fields.json from the personal vault's recommended schema
// (`pvault schema --json`) plus contract/extensions.json, the fields procedures
// need before the vault has them. The registry is the shared vocabulary between
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

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Who can have a field: only the vault's owner, or only a family member
// (whose fields carry their slug, leo:famiglia.relazione). Unset: both.
type For = "owner" | "member";

// The vault kinds a category or field exists in: persona (a personal vault)
// or impresa (a business vault). Unset: both.
type Kind = "persona" | "impresa";

interface VaultField {
  id: string;
  description: string;
  sensitivity: string;
  for?: For;
  kinds?: Kind[];
}

// person: the owner and every family member (leo:cie.numero); owner: the
// household or the owner's own affairs (abitazione, tari), never prefixed.
type Scope = "person" | "owner";

// What a category describes: a person (identity, residenza: the dichiarante's
// data in a business procedure) or a business (business, locale). Unset: neither.
type Subject = "persona" | "impresa";

interface VaultCategory {
  name: string;
  description: string;
  scope: Scope;
  subject?: Subject;
  kinds?: Kind[];
  fields: VaultField[] | null;
}

export interface VaultSchema {
  version: string;
  categories: VaultCategory[];
}

export interface Extensions {
  description?: string;
  categories: { name: string; description?: string; scope?: Scope; fields: { id: string; description: string }[] }[];
}

export interface Registry {
  version: string;
  source: string;
  categories: {
    name: string;
    description: string;
    scope: Scope;
    subject?: Subject;
    kinds?: Kind[];
    // vault: false marks a field (or a whole category) the vault doesn't have yet.
    fields: { id: string; description: string; for?: For; kinds?: Kind[]; vault?: false }[];
    vault?: false;
    // No fixed fields: any field name is allowed in this category.
    open?: boolean;
  }[];
  forbidden: { categories: string[]; fields: string[] };
}

const FORBIDDEN_CATEGORIES = ["spid", "payment", "medical"];
// The vault's own tracking of procedures in progress, not form data.
const INTERNAL_CATEGORIES = ["pratiche"];
const ALLOWED_SENSITIVITY = new Set(["public", "standard", "sensitive"]);
// Categories with no fixed fields that may hold any field name. Any other
// empty category is treated as secret until it is reviewed and listed here.
const OPEN_CATEGORIES = ["documents"];
// Credential words, kept in step with validate.ts and the vault's reCredentialWord.
const CREDENTIAL = /(^|_)(pin\d*|puk\d*|password|passwd|pwd|pw|pass|passcode|otp|totp|username|login|secret|segreto|chiave|token)(_|$)/;
const EXTENSION_ID = /^[a-z_]+\.[a-z0-9_]+$/;
const CATEGORY_NAME = /^[a-z_]+$/;
const SCOPES = new Set(["person", "owner"]);
const FOR = new Set([undefined, "owner", "member"]);
const SUBJECTS = new Set([undefined, "persona", "impresa"]);
const KINDS = new Set(["persona", "impresa"]);

function checkKinds(kinds: unknown, what: string) {
  if (kinds === undefined) return;
  if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((k) => !KINDS.has(k)) || new Set(kinds).size !== kinds.length) {
    throw new Error(`${what} has kinds ${JSON.stringify(kinds)}, not a list of persona and impresa`);
  }
}

export function buildRegistry(schema: VaultSchema, extensions: Extensions = { categories: [] }): Registry {
  if (!schema || typeof schema.version !== "string" || !Array.isArray(schema.categories)) {
    throw new Error("not a vault schema: expected { version, categories: [...] }");
  }
  if (!extensions || !Array.isArray(extensions.categories)) {
    throw new Error("not an extensions file: expected { categories: [...] }");
  }
  const forbiddenCategories = [...FORBIDDEN_CATEGORIES];
  const forbiddenFields: string[] = [];
  const categories: Registry["categories"] = [];

  for (const cat of schema.categories) {
    if (FORBIDDEN_CATEGORIES.includes(cat.name) || INTERNAL_CATEGORIES.includes(cat.name)) continue;
    if (!SCOPES.has(cat.scope)) throw new Error(`category "${cat.name}" needs a scope, person or owner`);
    if (!SUBJECTS.has(cat.subject)) throw new Error(`category "${cat.name}" has subject ${JSON.stringify(cat.subject)}, not persona or impresa`);
    checkKinds(cat.kinds, `category "${cat.name}"`);
    const vaultFields = cat.fields ?? [];
    const fields: Registry["categories"][number]["fields"] = [];
    for (const f of vaultFields) {
      checkFieldCategory(f.id, cat.name);
      if (!FOR.has(f.for)) throw new Error(`field "${f.id}" is for ${JSON.stringify(f.for)}, not owner or member`);
      checkKinds(f.kinds, `field "${f.id}"`);
      if (!ALLOWED_SENSITIVITY.has(f.sensitivity)) {
        forbiddenFields.push(f.id);
        continue;
      }
      fields.push({
        id: f.id,
        description: f.description,
        ...(f.for && { for: f.for }),
        ...(f.kinds && { kinds: f.kinds }),
      });
    }
    // Every field secret: the whole category is, rather than becoming open.
    if (vaultFields.length > 0 && fields.length === 0) {
      forbiddenCategories.push(cat.name);
      continue;
    }
    const entry: Registry["categories"][number] = {
      name: cat.name,
      description: cat.description,
      scope: cat.scope,
      ...(cat.subject && { subject: cat.subject }),
      ...(cat.kinds && { kinds: cat.kinds }),
      fields,
    };
    if (vaultFields.length === 0) {
      if (!OPEN_CATEGORIES.includes(cat.name)) {
        forbiddenCategories.push(cat.name);
        continue;
      }
      entry.open = true;
    }
    categories.push(entry);
  }

  const vaultIds = new Set(schema.categories.flatMap((c) => (c.fields ?? []).map((f) => f.id)));
  for (const ext of extensions.categories) {
    if (!CATEGORY_NAME.test(ext?.name ?? "") || !Array.isArray(ext.fields)) {
      throw new Error(`extension category ${JSON.stringify(ext?.name)} needs a lower-case name and a fields list`);
    }
    if (forbiddenCategories.includes(ext.name) || INTERNAL_CATEGORIES.includes(ext.name)) {
      throw new Error(`extensions can't add to category "${ext.name}"`);
    }
    let entry = categories.find((c) => c.name === ext.name);
    if (!entry) {
      if (!ext.description) throw new Error(`new category "${ext.name}" needs a description`);
      if (!SCOPES.has(ext.scope as string)) throw new Error(`new category "${ext.name}" needs a scope, person or owner`);
      entry = { name: ext.name, description: ext.description, scope: ext.scope!, vault: false, fields: [] };
      categories.push(entry);
    } else if (entry.open) {
      throw new Error(`extensions can't add fixed fields to open category "${ext.name}"`);
    }
    for (const f of ext.fields) {
      checkFieldCategory(f.id, ext.name);
      if (!EXTENSION_ID.test(f.id)) throw new Error(`extension field "${f.id}" must look like category.field_name`);
      if (forbiddenFields.includes(f.id)) throw new Error(`extension field "${f.id}" is a secret field in the vault`);
      if (CREDENTIAL.test(f.id.split(".")[1])) throw new Error(`extension field "${f.id}" looks like a credential`);
      if (vaultIds.has(f.id) || entry.fields.some((e) => e.id === f.id)) {
        throw new Error(`extension field "${f.id}" already exists; remove it from extensions.json`);
      }
      entry.fields.push({ id: f.id, description: f.description, vault: false });
    }
  }

  return {
    version: schema.version,
    source: "personal-vault RecommendedSchema + contract/extensions.json",
    categories,
    forbidden: { categories: forbiddenCategories, fields: forbiddenFields.sort() },
  };
}

function checkFieldCategory(id: string, category: string) {
  if (!id.startsWith(`${category}.`)) {
    throw new Error(`field "${id}" is listed under category "${category}"`);
  }
}

const CONTRACT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "contract");
export const VAULT_SCHEMA_PATH = path.join(CONTRACT, "vault-schema.json");
export const EXTENSIONS_PATH = path.join(CONTRACT, "extensions.json");
export const FIELDS_PATH = path.join(CONTRACT, "fields.json");

export function renderRegistry(schema: VaultSchema, extensions?: Extensions): string {
  return JSON.stringify(buildRegistry(schema, extensions), null, 2) + "\n";
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const input = process.argv[2];
  const schema = JSON.parse(readFileSync(input ?? VAULT_SCHEMA_PATH, "utf8")) as VaultSchema;
  const extensions = JSON.parse(readFileSync(EXTENSIONS_PATH, "utf8")) as Extensions;
  const registry = renderRegistry(schema, extensions); // validates before anything is written
  if (input) writeFileSync(VAULT_SCHEMA_PATH, JSON.stringify(schema, null, 2) + "\n");
  writeFileSync(FIELDS_PATH, registry);
  console.log(`wrote ${FIELDS_PATH}`);
}
