// Checks that contract/vault-schema.json is the personal vault's current
// schema: schema.json on main of personal-vault-italia, which a vault test
// keeps equal to `pvault schema --json`. Without it a vault schema change
// (a new field, a new credential word) would go unnoticed here.
// Usage: npm run check:vault-schema [-- <path to schema.json>]
// Without a path it reads the file through the GitHub API, with a token in
// VAULT_SCHEMA_TOKEN (or GH_TOKEN, GITHUB_TOKEN) that may read that private
// repository's contents.

import { readFileSync } from "node:fs";
import { VAULT_SCHEMA_PATH, type VaultSchema } from "./gen-fields.ts";
import { schemaDifferences } from "./lib/vault-schema.ts";

const REPO = "liammaher/personal-vault-italia";

async function currentSchema(file?: string): Promise<string> {
  if (file) return readFileSync(file, "utf8");
  const token = process.env.VAULT_SCHEMA_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(`needs VAULT_SCHEMA_TOKEN, a token that can read ${REPO}, or a path to its schema.json`);
  }
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/schema.json?ref=main`, {
    headers: { Accept: "application/vnd.github.raw+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${REPO}/schema.json (is schema.json on main, and may the token read the repository?)`);
  return res.text();
}

try {
  const current = JSON.parse(await currentSchema(process.argv[2])) as VaultSchema;
  const saved = JSON.parse(readFileSync(VAULT_SCHEMA_PATH, "utf8")) as VaultSchema;
  const differences = schemaDifferences(saved, current);
  if (differences.length === 0) {
    console.log(`contract/vault-schema.json is the vault's current schema (version ${current.version})`);
  } else {
    console.error(`contract/vault-schema.json is behind the vault's schema.json:\n${differences.map((d) => `  - ${d}`).join("\n")}`);
    console.error("Save the vault's schema.json and run npm run gen:fields -- schema.json, then check the procedures still validate.");
    process.exitCode = 1;
  }
} catch (e) {
  console.error(`can't compare with the vault's schema: ${(e as Error).message}`);
  process.exitCode = 2;
}
