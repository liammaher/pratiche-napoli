import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VAULT_SCHEMA_PATH, type VaultSchema } from "../gen-fields.ts";
import { schemaDifferences } from "./vault-schema.ts";

const saved: VaultSchema = JSON.parse(readFileSync(VAULT_SCHEMA_PATH, "utf8"));
const copy = (): VaultSchema => structuredClone(saved);

test("the same schema has no differences", () => {
  assert.deepEqual(schemaDifferences(saved, copy()), []);
});

test("each kind of change is named", () => {
  const now = copy();
  now.version = "99";
  now.categories.push({ name: "nuova", description: "", scope: "person", fields: [] });
  const identity = now.categories.find((c) => c.name === "identity")!;
  identity.fields!.push({ id: "identity.soprannome", description: "", sensitivity: "standard" });
  identity.fields![0].description = "changed";
  identity.subject = undefined;
  now.categories.find((c) => c.name === "cie")!.fields!.pop();
  now.categories = now.categories.filter((c) => c.name !== "patente");
  now.credentials = { ...now.credentials, secret: "^(pin)$" };
  assert.deepEqual(schemaDifferences(saved, now), [
    `version ${saved.version} → 99`,
    "category identity changed",
    "field identity.first_name changed",
    "new field identity.soprannome",
    `field ${saved.categories.find((c) => c.name === "cie")!.fields!.at(-1)!.id} removed`,
    "new category nuova",
    "category patente removed",
    "credential words changed",
  ]);
});

test("a change in order alone is still a difference", () => {
  const now = copy();
  now.categories.reverse();
  assert.deepEqual(schemaDifferences(saved, now), ["the schemas differ (order or other keys)"]);
});
