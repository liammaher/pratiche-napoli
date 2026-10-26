// What changed between the vault schema saved here (contract/vault-schema.json)
// and the vault's current one (schema.json in personal-vault-italia), said
// field by field, so a run that fails says what to look at.

import type { VaultSchema } from "../gen-fields.ts";
import { canonical } from "./updated.ts";

export function schemaDifferences(saved: VaultSchema, current: VaultSchema): string[] {
  const out: string[] = [];
  if (saved.version !== current.version) out.push(`version ${saved.version} → ${current.version}`);
  const byName = (s: VaultSchema) => new Map((s.categories ?? []).map((c) => [c.name, c]));
  const was = byName(saved);
  const now = byName(current);
  for (const [name, cat] of now) {
    const old = was.get(name);
    if (!old) {
      out.push(`new category ${name}`);
      continue;
    }
    const { fields: oldFields, ...oldRest } = old;
    const { fields: newFields, ...newRest } = cat;
    if (canonical(oldRest) !== canonical(newRest)) out.push(`category ${name} changed`);
    const oldById = new Map((oldFields ?? []).map((f) => [f.id, f]));
    const newById = new Map((newFields ?? []).map((f) => [f.id, f]));
    for (const [id, f] of newById) {
      if (!oldById.has(id)) out.push(`new field ${id}`);
      else if (canonical(oldById.get(id)) !== canonical(f)) out.push(`field ${id} changed`);
    }
    for (const id of oldById.keys()) if (!newById.has(id)) out.push(`field ${id} removed`);
  }
  for (const name of was.keys()) if (!now.has(name)) out.push(`category ${name} removed`);
  if (canonical(saved.credentials) !== canonical(current.credentials)) out.push("credential words changed");
  // Anything else, such as a new top-level key or the categories' order.
  if (out.length === 0 && canonical(saved) !== canonical(current)) out.push("the schemas differ (order or other keys)");
  return out;
}
