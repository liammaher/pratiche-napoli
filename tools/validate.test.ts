import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRegistry } from "./gen-fields.ts";
import { checkFieldRef, loadRegistry, validateProcedure, type Context } from "./lib/validate.ts";

const ctx: Context = {
  registry: loadRegistry(),
  knownIds: new Set(["napoli/comune/other"]),
  today: "2026-10-25",
};
const PATH = "procedures/napoli/comune/test.yaml";

function minimal(): Record<string, any> {
  return {
    schema_version: 0,
    id: "napoli/comune/test",
    title: "Test procedure",
    summary: "Una procedura di prova per i test del validatore.",
    ente: { name: "Comune di Napoli" },
    applies_to: { events: ["open"], audience: ["business"] },
    channels: [{ type: "pec", address: "ufficio@pec.comune.napoli.it" }],
    steps: [{ do: "Invia il modulo", who: "owner", human_only: true }],
    sources: [{ id: "page", label: "Pagina ufficiale", url: "https://www.comune.napoli.it/", retrieved: "2026-10-25", official: true }],
    verification: { level: "L1", date: "2026-10-25", by: "test", method: "desk" },
  };
}

test("a minimal procedure is valid", () => {
  assert.deepEqual(validateProcedure(minimal(), PATH, ctx), []);
});

test("schema errors are reported", () => {
  const doc = minimal();
  delete doc.steps;
  assert.match(validateProcedure(doc, PATH, ctx).join("\n"), /schema: .*steps/);
});

test("id must match the file path", () => {
  const doc = minimal();
  doc.id = "napoli/comune/elsewhere";
  assert.match(validateProcedure(doc, PATH, ctx).join("\n"), /must match its path/);
});

test("form mappings must use registered, non-secret fields", () => {
  const doc = minimal();
  doc.forms = [{
    id: "mod",
    name: "Modulo",
    fields: [
      { label: "CF", map: { direct: "identity.codice_fiscale" } },
      { label: "Nome", map: { concat: ["identity.last_name", "identity.first_name"] } },
      { label: "Indirizzo", map: { fallback: ["domicilio.*", "residenza.*"] } },
      { label: "Conviventi", map: { repeat: "nucleo_familiare.membro<N>_*" } },
      { label: "Codice", map: { blank_with_reason: "assegnato dal Comune" } },
      { label: "Insegna", map: { ask: "Testo dell'insegna" } },
    ],
  }];
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);

  doc.forms[0].fields.push({ label: "Bad", map: { direct: "identity.shoe_size" } });
  doc.forms[0].fields.push({ label: "Secret", map: { direct: "spid.password" } });
  const errors = validateProcedure(doc, PATH, ctx).join("\n");
  assert.match(errors, /unknown field "identity.shoe_size"/);
  assert.match(errors, /spid.password is a secret or payment field/);
});

test("a malformed mapping gives one readable error", () => {
  const doc = minimal();
  doc.forms = [{ id: "mod", name: "Modulo", fields: [{ label: "X", map: { ask: "a", direct: "identity.email" } }] }];
  const errors = validateProcedure(doc, PATH, ctx);
  assert.deepEqual(errors, [
    "schema: /forms/0/fields/0/map must be exactly one of: direct, concat, fallback, repeat, blank_with_reason, ask",
  ]);
});

test("field refs: categories, dynamic patterns and forbidden fields", () => {
  const r = ctx.registry;
  assert.equal(checkFieldRef("business.partita_iva", r), null);
  assert.equal(checkFieldRef("documents.anything", r), null); // open category
  assert.match(checkFieldRef("identity.membro<N>_nome", r) ?? "", /no per-item fields/);
  assert.match(checkFieldRef("cie.pin", r) ?? "", /secret/);
  assert.match(checkFieldRef("nope.field", r) ?? "", /unknown category/);
});

test("verified claims need a source, and sources must exist", () => {
  const doc = minimal();
  doc.deadline = {
    rules: [
      { text: "Entro 90 giorni", status: "verified" },
      { text: "Entro il 30 giugno", status: "unverified", source: "missing" },
    ],
  };
  const errors = validateProcedure(doc, PATH, ctx).join("\n");
  assert.match(errors, /verified claim must cite a source/);
  assert.match(errors, /unknown source "missing"/);
});

test("personal data is rejected", () => {
  const doc = minimal();
  doc.after = ["Salva il codice RSSMRA85T10A562S"];
  doc.pitfalls = [{ text: "Paga su IT60X0542811101000000123456", status: "unverified" }];
  const errors = validateProcedure(doc, PATH, ctx).join("\n");
  assert.match(errors, /codice fiscale/);
  assert.match(errors, /IBAN/);
});

test("related procedures must exist and dates can't be in the future", () => {
  const doc = minimal();
  doc.related = ["napoli/comune/other", "napoli/comune/ghost"];
  doc.verification.date = "2027-01-01";
  const errors = validateProcedure(doc, PATH, ctx).join("\n");
  assert.match(errors, /related "napoli\/comune\/ghost"/);
  assert.doesNotMatch(errors, /related "napoli\/comune\/other"/);
  assert.match(errors, /verification date is in the future/);
});

test("L1 and above need an official source with a URL", () => {
  const doc = minimal();
  doc.sources[0].official = false;
  assert.match(validateProcedure(doc, PATH, ctx).join("\n"), /needs at least one official source/);
  doc.verification.level = "L0";
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);
});

test("registry leaves secrets out and marks dynamic and open categories", () => {
  const reg = buildRegistry({
    version: "1",
    categories: [
      { name: "cie", description: "", fields: [
        { id: "cie.numero", description: "", sensitivity: "sensitive" },
        { id: "cie.pin", description: "", sensitivity: "critical" },
      ] },
      { name: "spid", description: "", fields: [{ id: "spid.password", description: "", sensitivity: "personal" }] },
      { name: "nucleo_familiare", description: "", fields: [] },
      { name: "documents", description: "", fields: null },
    ],
  });
  assert.deepEqual(reg.categories.map((c) => c.name), ["cie", "nucleo_familiare", "documents"]);
  assert.deepEqual(reg.categories[0].fields.map((f) => f.id), ["cie.numero"]);
  assert.deepEqual(reg.forbidden.fields, ["cie.pin"]);
  assert.equal(reg.categories[1].dynamic, "membro<N>_<campo>");
  assert.equal(reg.categories[2].open, true);
});
