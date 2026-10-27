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
  // What the field may hold (each item of a list, as ruolo.tipo): the vault's
  // own list, so nothing here keeps a copy (validate.ts reads it from fields.json).
  values?: string[];
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
  // One per holder (famiglia, ruolo): the vault refuses numbered copies of it
  // (famiglia2), which it allows for any other category (locale2).
  one_only?: boolean;
  fields: VaultField[] | null;
}

export interface VaultSchema {
  version: string;
  categories: VaultCategory[];
  // The vault's credential rule, as whole-word patterns: secret anywhere,
  // credential (secret plus username, login...) next to SPID or the CIE.
  // account: the first word of a SPID/CieID account category (spid_poste),
  // every field of which the vault keeps as a secret.
  credentials: { secret: string; credential: string; identity: string; account: string };
}

export interface Extensions {
  description?: string;
  categories: {
    name: string;
    description?: string;
    scope?: Scope;
    subject?: Subject;
    kinds?: Kind[];
    fields: { id: string; description: string; kinds?: Kind[] }[];
  }[];
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
    // No numbered copies (see VaultCategory); a procedure may name locale2 but not famiglia2.
    one_only?: true;
    // vault: false marks a field (or a whole category) the vault doesn't have yet.
    fields: { id: string; description: string; for?: For; kinds?: Kind[]; values?: string[]; vault?: false }[];
    vault?: false;
    // No fixed fields: any field name is allowed in this category.
    open?: boolean;
  }[];
  forbidden: { categories: string[]; fields: string[] };
  // The vault's pattern for one word of a field name (split at _ and -) that
  // names a login secret; see isCredentialName.
  credential_word: string;
  // The vault's pattern for a word naming SPID, the CIE or a digital
  // signature: run together with a credential word (ciepin), a secret too.
  identity_word: string;
}

const FORBIDDEN_CATEGORIES = ["spid", "payment", "medical"];
// The vault's own tracking of procedures in progress, not form data.
const INTERNAL_CATEGORIES = ["pratiche"];
const ALLOWED_SENSITIVITY = new Set(["public", "standard", "sensitive"]);
// Categories with no fixed fields that may hold any field name. Any other
// empty category is treated as secret until it is reviewed and listed here.
const OPEN_CATEGORIES = ["documents"];
const EXTENSION_ID = /^[a-z_]+\.[a-z0-9_]+$/;
const CATEGORY_NAME = /^[a-z_]+$/;
const SCOPES = new Set(["person", "owner"]);
const FOR = new Set([undefined, "owner", "member"]);
const SUBJECTS = new Set([undefined, "persona", "impresa"]);
const KINDS = new Set(["persona", "impresa"]);

// A field name naming a login secret: a word the vault calls a credential,
// in any category (the vault needs SPID or the CIE next to username, login
// or pass; a public procedure has no use for any of them), one run together
// with a SPID/CIE word as the vault reads it (ciepin, passwordspid), or a token.
export function isCredentialName(name: string, words: Pick<Registry, "credential_word" | "identity_word">): boolean {
  const word = new RegExp(words.credential_word);
  // Both are whole-word patterns, ^(...)$ (buildRegistry checks): their insides, in either order.
  const credential = words.credential_word.slice(2, -2);
  const identity = words.identity_word.slice(2, -2);
  const joined = new RegExp(`^(${identity})(${credential})$|^(${credential})(${identity})$`);
  return name.split(/[_-]/).some((w) => w === "token" || word.test(w) || joined.test(w));
}

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
  const words = schema.credentials;
  for (const key of ["secret", "credential", "identity", "account"] as const) {
    if (typeof words?.[key] !== "string" || !words[key].startsWith("^(") || !words[key].endsWith(")$")) {
      throw new Error(`not a vault schema: credentials.${key} must be a whole-word pattern (a vault older than schema.json?)`);
    }
    new RegExp(words[key]); // throws on a pattern JavaScript can't read
  }
  const credentialWords = { credential_word: words.credential, identity_word: words.identity };
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
    if (cat.one_only !== undefined && typeof cat.one_only !== "boolean") throw new Error(`category "${cat.name}" has one_only ${JSON.stringify(cat.one_only)}, not true or false`);
    const vaultFields = cat.fields ?? [];
    const fields: Registry["categories"][number]["fields"] = [];
    for (const f of vaultFields) {
      checkFieldCategory(f.id, cat.name);
      if (!FOR.has(f.for)) throw new Error(`field "${f.id}" is for ${JSON.stringify(f.for)}, not owner or member`);
      checkKinds(f.kinds, `field "${f.id}"`);
      if (f.values !== undefined && !(Array.isArray(f.values) && f.values.every((v) => typeof v === "string"))) {
        throw new Error(`field "${f.id}" has values ${JSON.stringify(f.values)}, not a list of strings`);
      }
      if (!ALLOWED_SENSITIVITY.has(f.sensitivity)) {
        forbiddenFields.push(f.id);
        continue;
      }
      fields.push({
        id: f.id,
        description: f.description,
        ...(f.for && { for: f.for }),
        ...(f.kinds && { kinds: f.kinds }),
        ...(f.values && { values: f.values }),
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
      ...(cat.one_only && { one_only: true as const }),
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
    // The vault keeps every field of a SPID/CieID account category secret.
    const account = new RegExp(words.account);
    if (!entry && (isCredentialName(ext.name, credentialWords) || account.test(ext.name.split(/[_-]/)[0]))) {
      throw new Error(`extension category "${ext.name}" looks like a credential`);
    }
    if (!entry) {
      if (!ext.description) throw new Error(`new category "${ext.name}" needs a description`);
      if (!SCOPES.has(ext.scope as string)) throw new Error(`new category "${ext.name}" needs a scope, person or owner`);
      if (!SUBJECTS.has(ext.subject)) throw new Error(`category "${ext.name}" has subject ${JSON.stringify(ext.subject)}, not persona or impresa`);
      checkKinds(ext.kinds, `category "${ext.name}"`);
      entry = {
        name: ext.name,
        description: ext.description,
        scope: ext.scope!,
        ...(ext.subject && { subject: ext.subject }),
        ...(ext.kinds && { kinds: ext.kinds }),
        vault: false,
        fields: [],
      };
      categories.push(entry);
    } else if (entry.open) {
      throw new Error(`extensions can't add fixed fields to open category "${ext.name}"`);
    } else if (ext.subject !== undefined || ext.kinds !== undefined || ext.scope !== undefined) {
      throw new Error(`extensions can't change the scope, subject or kinds of vault category "${ext.name}"`);
    }
    for (const f of ext.fields) {
      checkFieldCategory(f.id, ext.name);
      if (!EXTENSION_ID.test(f.id)) throw new Error(`extension field "${f.id}" must look like category.field_name`);
      if (forbiddenFields.includes(f.id)) throw new Error(`extension field "${f.id}" is a secret field in the vault`);
      if (isCredentialName(f.id.split(".")[1], credentialWords)) throw new Error(`extension field "${f.id}" looks like a credential`);
      if (vaultIds.has(f.id) || entry.fields.some((e) => e.id === f.id)) {
        throw new Error(`extension field "${f.id}" already exists; remove it from extensions.json`);
      }
      checkKinds(f.kinds, `extension field "${f.id}"`);
      entry.fields.push({ id: f.id, description: f.description, ...(f.kinds && { kinds: f.kinds }), vault: false });
    }
  }

  return {
    version: schema.version,
    source: "personal-vault RecommendedSchema + contract/extensions.json",
    categories,
    forbidden: { categories: forbiddenCategories, fields: forbiddenFields.sort() },
    credential_word: words.credential,
    identity_word: words.identity,
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
