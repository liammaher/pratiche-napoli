import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { EXTENSIONS_PATH, FIELDS_PATH, VAULT_SCHEMA_PATH, buildRegistry, renderRegistry, type VaultSchema } from "./gen-fields.ts";
import {
  ROOT,
  checkFieldRef,
  loadRegistry,
  todayInRome,
  validateDir,
  validateProcedure,
  type Context,
} from "./lib/validate.ts";

const ctx: Context = {
  registry: loadRegistry(),
  knownIds: new Set(["napoli/comune/test", "napoli/comune/other"]),
  today: "2026-10-25",
};
const PATH = "procedures/napoli/comune/test.yaml";

function minimal(): Record<string, any> {
  return {
    schema_version: 0,
    id: "napoli/comune/test",
    title: "Test procedure",
    headline: "Come fare la procedura di prova",
    updated: "2026-10-25",
    summary: "Una procedura di prova per i test del validatore.",
    ente: { name: "Comune di Napoli" },
    applies_to: { events: ["open"], audience: ["business"] },
    channels: [{ type: "pec", address: "ufficio@pec.comune.napoli.it" }],
    steps: [{ do: "Invia il modulo", who: "owner", human_only: true }],
    sources: [{ id: "page", label: "Pagina ufficiale", url: "https://www.comune.napoli.it/", retrieved: "2026-10-25", official: true }],
    verification: { level: "L1", date: "2026-10-25", by: "test", method: "desk" },
  };
}

function errorsFor(doc: Record<string, any>): string {
  return validateProcedure(doc, PATH, ctx).join("\n");
}

function withForm(...fields: Record<string, any>[]): Record<string, any> {
  const doc = minimal();
  doc.forms = [{ id: "mod", name: "Modulo", fields }];
  return doc;
}

test("a minimal procedure is valid", () => {
  assert.deepEqual(validateProcedure(minimal(), PATH, ctx), []);
});

test("schema errors are reported", () => {
  const doc = minimal();
  delete doc.steps;
  assert.match(errorsFor(doc), /schema: .*steps/);
});

test("id must match the file path", () => {
  const doc = minimal();
  doc.id = "napoli/comune/elsewhere";
  assert.match(errorsFor(doc), /must match its path/);
});

test("form mappings must use registered, non-secret fields", () => {
  const doc = withForm(
    { label: "CF", map: { direct: "identity.codice_fiscale" } },
    { label: "Nome", map: { concat: ["identity.last_name", "identity.first_name"] } },
    { label: "Indirizzo", map: { fallback: ["domicilio.*", "residenza.*"] } },
    { label: "Conviventi", map: { repeat: "famiglia", fields: ["*:identity.first_name", "*:famiglia.relazione"] } },
    { label: "Codice", map: { blank_with_reason: "assegnato dal Comune" } },
    { label: "Insegna", map: { ask: "Testo dell'insegna" } },
  );
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);

  doc.forms[0].fields.push({ label: "Bad", map: { direct: "identity.shoe_size" } });
  doc.forms[0].fields.push({ label: "Secret", map: { direct: "spid.password" } });
  const errors = errorsFor(doc);
  assert.match(errors, /unknown field "identity.shoe_size"/);
  assert.match(errors, /spid.password can't be used in a public procedure/);
});

test("records name exact registered fields, once each, never secrets or tracking", () => {
  const doc = minimal();
  doc.records = [
    { field: "tari.codice_contribuente", from: "Risposta del Comune" },
    { field: "business.rea", from: "Ricevuta del Registro Imprese" },
  ];
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);

  doc.records.push(
    { field: "tari.codice_contribuente", from: "Avviso di pagamento" },
    { field: "identity.shoe_size", from: "Modulo" },
    { field: "spid.password", from: "Modulo" },
    { field: "pratiche.tari_protocollo", from: "Ricevuta" },
  );
  const errors = errorsFor(doc);
  assert.match(errors, /records: "tari.codice_contribuente" is listed twice/);
  assert.match(errors, /records: unknown field "identity.shoe_size"/);
  assert.match(errors, /records: spid.password can't be used in a public procedure/);
  assert.match(errors, /records: unknown category "pratiche"/);

  const member = minimal();
  member.records = [{ field: "famiglia.relazione", from: "Modulo" }];
  assert.match(errorsFor(member), /records: famiglia.relazione is a family member's field, never the vault owner's/);
  assert.doesNotMatch(errorsFor(member), /repeat/);

  for (const field of ["tari.*", "*:identity.first_name", "leo:cie.numero", "pratiche.tari-2026_protocollo"]) {
    const bad = minimal();
    bad.records = [{ field, from: "Modulo" }];
    assert.match(errorsFor(bad), /schema: \/records\/0\/field/);
  }
});

test("wildcards can't sweep in secret fields", () => {
  for (const map of [
    { direct: "cie.*" },
    { concat: ["cie.*", "identity.email"] },
    { fallback: ["financial.*", "identity.email"] },
  ]) {
    assert.match(errorsFor(withForm({ label: "X", map })), /secret or payment field/, JSON.stringify(map));
  }
});

test("credential-like names are refused in open categories and member rows", () => {
  for (const ref of ["documents.cie_pin", "documents.spid_password", "documents.otp"]) {
    assert.match(checkFieldRef(ref, ctx.registry) ?? "", /secret/, ref);
  }
  assert.match(errorsFor(withForm({ label: "X", map: { repeat: "famiglia", fields: ["*:documents.cie_pin"] } })), /secret/);
});

test("member refs: scopes, owner-only and member-only fields", () => {
  const r = ctx.registry;
  assert.equal(checkFieldRef("*:identity.first_name", r), null);
  assert.equal(checkFieldRef("leo:cie.numero", r), null);
  assert.equal(checkFieldRef("*:identity.*", r), null);
  assert.equal(checkFieldRef("*:famiglia.relazione", r), null);
  assert.equal(checkFieldRef("famiglia.intestatario_scheda", r), null);
  assert.match(checkFieldRef("famiglia.relazione", r) ?? "", /family member's field, never the vault owner's/);
  assert.match(checkFieldRef("*:famiglia.intestatario_scheda", r) ?? "", /owner's field only/);
  assert.match(checkFieldRef("*:abitazione.superficie_calpestabile_mq", r) ?? "", /drop the "\*:" prefix/);
  assert.match(checkFieldRef("leo:tari.*", r) ?? "", /vault owner's \(the household's\)/);
  assert.match(checkFieldRef("io:identity.first_name", r) ?? "", /reserved for the vault's owner/);
  for (const ref of ["Leo:identity.first_name", "leo rossi:identity.first_name", "9leo:identity.first_name", ":identity.first_name"]) {
    assert.match(checkFieldRef(ref, r) ?? "", /invalid member/, ref);
  }
  // As in the vault, a ':' after the first '.' isn't a prefix.
  assert.match(checkFieldRef("identity.a:b", r) ?? "", /unknown field "identity.a:b"/);
  assert.match(checkFieldRef("*:cie.pin", r) ?? "", /secret/);
  assert.match(checkFieldRef("*:cie.*", r) ?? "", /secret/);
  assert.match(checkFieldRef("*:identity.shoe_size", r) ?? "", /unknown field "identity.shoe_size"/);
});

test("repeat: famiglia fills each row from *: fields, and only it can use them", () => {
  const row = (fields: string[]) => errorsFor(withForm({ label: "X", map: { repeat: "famiglia", fields } }));
  assert.equal(row(["*:identity.last_name", "*:identity.codice_fiscale", "*:famiglia.relazione"]), "");
  assert.match(row(["identity.first_name"]), /each row is filled from that member's fields, written \*:category.field/);
  assert.match(row(["tari.codice_contribuente"]), /each row is filled from that member's fields/);
  assert.match(row(["io:identity.first_name"]), /"io" is reserved/);
  assert.match(errorsFor(withForm({ label: "X", map: { direct: "io:identity.first_name" } })), /"io" is reserved/);
  assert.match(row(["leo:identity.first_name"]), /can't name a particular family member \("leo"\)/);
  assert.match(row(["*:tari.codice_contribuente"]), /vault owner's/);
  assert.match(errorsFor(withForm({ label: "X", map: { direct: "*:identity.first_name" } })), /only repeat: famiglia can fill/);
  assert.match(
    errorsFor(withForm({ label: "X", map: { concat: ["leo:identity.last_name", "identity.first_name"] } })),
    /can't name a particular family member/,
  );
  assert.match(errorsFor(withForm({ label: "X", map: { direct: "nucleo_familiare.membro1_nome" } })), /unknown category "nucleo_familiare"/);
  assert.match(errorsFor(withForm({ label: "X", map: { direct: "pratiche.slug_stato" } })), /unknown category "pratiche"/);
});

test("repeat takes only famiglia, with fields, and <N> patterns are refused", () => {
  for (const map of [
    { repeat: "nucleo_familiare.membro<N>_*" },
    { repeat: "famiglia" },
    { repeat: "famiglia", fields: [] },
    { repeat: "identity.email", fields: ["*:identity.email"] },
    { repeat: "famiglia", fields: ["*:identity.first_name", "*:identity.first_name"] },
    { direct: "nucleo_familiare.membro<N>_nome" },
    { direct: "Leo:identity.first_name" },
  ]) {
    assert.match(errorsFor(withForm({ label: "X", map })), /must be exactly one of/, JSON.stringify(map));
  }
});

test("field refs: categories, wildcards and forbidden fields", () => {
  const r = ctx.registry;
  assert.equal(checkFieldRef("business.partita_iva", r), null);
  assert.equal(checkFieldRef("residenza.*", r), null);
  assert.equal(checkFieldRef("documents.anything", r), null); // open category
  assert.match(checkFieldRef("cie.pin", r) ?? "", /secret/);
  assert.match(checkFieldRef("nope.field", r) ?? "", /unknown category/);
});

test("a malformed mapping gives one readable error", () => {
  for (const map of [{ ask: "a", direct: "identity.email" }, { concat: ["Identity.Email"] }]) {
    const errors = validateProcedure(withForm({ label: "X", map }), PATH, ctx);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /^schema: \/forms\/0\/fields\/0\/map must be exactly one of direct, concat/);
  }
});

test("verified claims need an official source, and sources must exist", () => {
  const doc = minimal();
  doc.sources.push({ id: "blog", label: "Un blog", retrieved: "2026-10-25" });
  doc.deadline = {
    rules: [
      { text: "Entro 90 giorni", status: "verified" },
      { text: "Entro il 30 giugno", status: "unverified", source: "missing" },
      { text: "Entro 60 giorni", status: "verified", source: "blog" },
      { text: "Entro 30 giorni", status: "verified", source: "page" },
    ],
  };
  const errors = errorsFor(doc);
  assert.match(errors, /verified claim must cite a source/);
  assert.match(errors, /unknown source "missing"/);
  assert.match(errors, /must cite an official source, not "blog"/);
  assert.equal(errors.split("\n").length, 3);
});

test("channels can cite a source, which must exist", () => {
  const doc = minimal();
  doc.channels[0].source = "page";
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);
  doc.channels[0].source = "nowhere";
  assert.match(errorsFor(doc), /unknown source "nowhere"/);
});

test("personal data is rejected, however it is written", () => {
  for (const text of [
    "Salva il codice RSSMRA85T10A562S",
    "codice rssmra85t10a562s",
    "cf_RSSMRA85T10A562S",
    "RSS MRA 85T10 A562S",
    "Paga su IT60X0542811101000000123456",
    "IBAN IT60 X054 2811 1010 0000 0123 456",
    "conto DE89370400440532013000",
  ]) {
    const doc = minimal();
    doc.after = [text];
    assert.match(errorsFor(doc), /personal data/, text);
  }
});

test("ordinary text, codes and phone numbers are not personal data", () => {
  const doc = minimal();
  doc.after = [
    "Codice ente F839, codici tributo 3944 e TEFA, rateazione 0101",
    "Telefono 081 795 3711, lunedì–venerdì 9:00–13:00",
    "RSSMRA85T10A562X", // wrong check character
    "sovrastrutturale e precipitosamente",
  ];
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);
});

test("related procedures must exist, not repeat, and not point to themselves", () => {
  const doc = minimal();
  doc.related = ["napoli/comune/other", "napoli/comune/ghost", "napoli/comune/test"];
  const errors = errorsFor(doc);
  assert.match(errors, /related "napoli\/comune\/ghost"/);
  assert.match(errors, /related to itself/);
  assert.doesNotMatch(errors, /related "napoli\/comune\/other"/);
  doc.related = ["napoli/comune/other", "napoli/comune/other"];
  assert.match(errorsFor(doc), /duplicate items/);
});

test("no dates in the future, and pages aren't updated after they were read", () => {
  const doc = minimal();
  doc.verification.date = "2027-01-01";
  doc.run_log = [{ date: "2099-01-01", note: "x" }];
  doc.sources[0].page_updated = "2099-01-01";
  const errors = errorsFor(doc);
  assert.match(errors, /verification date is in the future/);
  assert.match(errors, /run_log entry dated 2099-01-01/);
  assert.match(errors, /updated in the future/);
  assert.match(errors, /updated after it was retrieved/);
});

test("today is the date in Rome, not UTC", () => {
  assert.equal(todayInRome(new Date("2026-10-25T23:30:00Z")), "2026-10-26");
  assert.equal(todayInRome(new Date("2026-07-01T22:30:00Z")), "2026-07-02");
  assert.equal(todayInRome(new Date("2026-10-25T12:00:00Z")), "2026-10-25");
});

test("updated is required, not in the future, and not older than anything it covers", () => {
  const missing = minimal();
  delete missing.updated;
  assert.match(errorsFor(missing), /schema: .*updated/);

  const future = minimal();
  future.updated = "2026-10-26";
  assert.match(errorsFor(future), /updated is in the future/);

  const stale = minimal();
  stale.updated = "2026-10-20";
  stale.run_log = [{ date: "2026-10-24", note: "Caso reale" }];
  const errors = errorsFor(stale);
  assert.match(errors, /updated 2026-10-20 is older than verification \(2026-10-25\), source "page" \(2026-10-25\), run_log entry 2026-10-24: bump it/);
});

test("cost, duration and appointment are claims", () => {
  const doc = minimal();
  doc.cost = { text: "Gratuita.", status: "verified" };
  assert.match(errorsFor(doc), /\/cost\/status: a verified claim must cite a source/);
  doc.cost.source = "page";
  doc.duration = { text: "30 giorni.", status: "unverified" };
  doc.appointment = { text: "Non serve.", status: "verified", source: "nope" };
  assert.match(errorsFor(doc), /\/appointment\/source: unknown source "nope"/);
  doc.appointment.source = "page";
  doc.aka = ["provina"];
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);
  doc.headline = "Troppo";
  assert.match(errorsFor(doc), /schema: \/headline/);
  delete doc.headline;
  assert.match(errorsFor(doc), /schema: \/ must have required property 'headline'/);
});

test("payment codes have a status like any claim", () => {
  const doc = minimal();
  doc.payment = { method: "f24", codice_ente: "F839", status: "verified" };
  assert.match(errorsFor(doc), /\/payment\/status: a verified claim must cite a source/);
  doc.payment.source = "page";
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);
  doc.payment.source = "nope";
  assert.match(errorsFor(doc), /unknown source "nope"/);
});

test("L1 and above need an official http(s) source", () => {
  const doc = minimal();
  doc.sources[0].official = false;
  assert.match(errorsFor(doc), /needs at least one official source/);
  doc.verification.level = "L0";
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "x:y"]) {
    const bad = minimal();
    bad.sources[0].url = url;
    assert.match(errorsFor(bad), /schema: \/sources\/0\/url must match pattern/, url);
  }
});

test("empty strings and duplicate list items are rejected", () => {
  const doc = minimal();
  doc.ente.name = " ";
  doc.steps[0].do = "";
  doc.applies_to.events = ["open", "open"];
  const errors = errorsFor(doc);
  assert.match(errors, /\/ente\/name/);
  assert.match(errors, /\/steps\/0\/do/);
  assert.match(errors, /\/applies_to\/events must NOT have duplicate items/);
});

test("registry leaves secrets and internal categories out", () => {
  const reg = buildRegistry({
    version: "1",
    categories: [
      { name: "cie", description: "", scope: "person", fields: [
        { id: "cie.numero", description: "", sensitivity: "sensitive" },
        { id: "cie.pin", description: "", sensitivity: "critical" },
        { id: "cie.new_tier", description: "", sensitivity: "Critical" },
      ] },
      { name: "spid", description: "", scope: "person", fields: [{ id: "spid.password", description: "", sensitivity: "personal" }] },
      { name: "cieid", description: "", scope: "person", fields: [
        { id: "cieid.password", description: "", sensitivity: "personal" },
        { id: "cieid.otp_seed", description: "", sensitivity: "critical" },
      ] },
      { name: "pratiche", description: "", scope: "owner", fields: [] },
      { name: "famiglia", description: "", scope: "person", fields: [
        { id: "famiglia.intestatario_scheda", description: "", sensitivity: "standard", for: "owner" },
        { id: "famiglia.relazione", description: "", sensitivity: "standard", for: "member" },
      ] },
      { name: "tari", description: "", scope: "owner", fields: [{ id: "tari.protocollo", description: "", sensitivity: "standard" }] },
      { name: "documents", description: "", scope: "person", fields: null },
    ],
  });
  assert.deepEqual(reg.categories.map((c) => [c.name, c.scope]), [["cie", "person"], ["famiglia", "person"], ["tari", "owner"], ["documents", "person"]]);
  assert.deepEqual(reg.categories[0].fields.map((f) => f.id), ["cie.numero"]);
  assert.deepEqual(reg.forbidden.fields, ["cie.new_tier", "cie.pin", "cieid.otp_seed", "cieid.password"]);
  assert.ok(reg.forbidden.categories.includes("cieid"));
  assert.deepEqual(reg.categories[1].fields.map((f) => [f.id, f.for]), [["famiglia.intestatario_scheda", "owner"], ["famiglia.relazione", "member"]]);
  assert.equal("for" in reg.categories[2].fields[0], false);
  assert.equal(reg.categories[3].open, true);
  assert.equal(checkFieldRef("cieid.otp_seed2", reg), "cieid.otp_seed2 can't be used in a public procedure: it is (or includes) a secret or payment field");
});

test("registry rejects malformed vault schemas", () => {
  assert.throws(() => buildRegistry({ version: "9" } as any), /not a vault schema/);
  assert.throws(
    () => buildRegistry({ version: "1", categories: [{ name: "x", description: "", scope: "person", fields: [{ id: "y.z", description: "", sensitivity: "standard" }] }] }),
    /listed under category "x"/,
  );
  assert.throws(() => buildRegistry({ version: "1", categories: [{ name: "x", description: "", fields: [] }] } as any), /"x" needs a scope/);
  assert.throws(
    () => buildRegistry({ version: "1", categories: [{ name: "x", description: "", scope: "person", fields: [{ id: "x.y", description: "", sensitivity: "standard", for: "child" }] }] } as any),
    /"x.y" is for "child"/,
  );
});

test("fields.json is exactly what gen-fields builds from the saved vault schema", () => {
  const schema = JSON.parse(readFileSync(VAULT_SCHEMA_PATH, "utf8"));
  const extensions = JSON.parse(readFileSync(EXTENSIONS_PATH, "utf8"));
  assert.equal(readFileSync(FIELDS_PATH, "utf8"), renderRegistry(schema, extensions), "run npm run gen:fields");
});

test("extensions add fields marked as not yet in the vault, and can't clash or reach secrets", () => {
  const schema: VaultSchema = {
    version: "1",
    categories: [
      { name: "business", description: "", scope: "person", fields: [{ id: "business.partita_iva", description: "", sensitivity: "standard" }] },
      { name: "spid", description: "", scope: "person", fields: [{ id: "spid.password", description: "", sensitivity: "personal" }] },
      { name: "documents", description: "", scope: "person", fields: null },
    ],
  };
  const reg = buildRegistry(schema, {
    categories: [
      { name: "business", fields: [{ id: "business.email", description: "" }] },
      { name: "locale", description: "Premises", scope: "person", fields: [{ id: "locale.superficie_mq", description: "" }] },
    ],
  });
  const business = reg.categories.find((c) => c.name === "business")!;
  assert.deepEqual(business.fields.map((f) => [f.id, f.vault]), [["business.partita_iva", undefined], ["business.email", false]]);
  const locale = reg.categories.find((c) => c.name === "locale")!;
  assert.equal(locale.vault, false);
  assert.equal(locale.scope, "person");
  assert.equal(checkFieldRef("locale.superficie_mq", reg), null);

  const ext = (categories: any[]) => () => buildRegistry(schema, { categories });
  assert.throws(ext([{ name: "business", fields: [{ id: "business.partita_iva", description: "" }] }]), /already exists/);
  assert.throws(ext([{ name: "spid", fields: [{ id: "spid.otp", description: "" }] }]), /can't add to category "spid"/);
  assert.throws(ext([{ name: "pratiche", fields: [{ id: "pratiche.x", description: "" }] }]), /can't add to category "pratiche"/);
  assert.throws(ext([{ name: "documents", fields: [{ id: "documents.x", description: "" }] }]), /open category "documents"/);
  assert.throws(ext([{ name: "nuova", fields: [{ id: "nuova.x", description: "" }] }]), /needs a description/);
  assert.throws(ext([{ name: "nuova", description: "x", fields: [{ id: "nuova.x", description: "" }] }]), /needs a scope/);
  assert.throws(ext([{ name: "business", fields: [{ id: "locale.x", description: "" }] }]), /listed under category "business"/);
});

test("every registry field is usable and every forbidden one is refused", () => {
  const reg = ctx.registry;
  for (const c of reg.categories) {
    for (const f of c.fields) {
      const ref = f.for === "member" ? `*:${f.id}` : f.id;
      assert.equal(checkFieldRef(ref, reg), null, ref);
    }
  }
  for (const f of reg.forbidden.fields) assert.notEqual(checkFieldRef(f, reg), null, f);
});

// --- whole-directory and CLI behaviour ---

function tempLibrary(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pratiche-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const VALID_YAML = JSON.stringify(minimal()); // JSON is valid YAML

test("a bad YAML file is reported and the rest are still checked", () => {
  const dir = tempLibrary({
    "napoli/comune/test.yaml": VALID_YAML,
    "napoli/comune/broken.yaml": "id: [unclosed\n",
    "napoli/comune/multi.yml": "a: 1\n---\nb: 2\n",
    "napoli/comune/Upper.YAML": "{}",
  });
  const results = validateDir(dir, ctx.registry, "2026-10-25");
  const byFile = Object.fromEntries(results.map((r) => [r.rel.replace(/\\/g, "/"), r.errors.join("\n")]));
  assert.equal(byFile["napoli/comune/test.yaml"], "");
  assert.match(byFile["napoli/comune/broken.yaml"], /not valid YAML/);
  assert.match(byFile["napoli/comune/multi.yml"], /not valid YAML/);
  assert.match(byFile["napoli/comune/Upper.YAML"], /schema:/);
});

test("ids for related come from file paths, not from what files claim", () => {
  const misplaced = { ...minimal(), id: "napoli/comune/claimed" };
  const linking = { ...minimal(), id: "napoli/comune/test", related: ["napoli/comune/claimed"] };
  const dir = tempLibrary({
    "napoli/comune/test.yaml": JSON.stringify(linking),
    "napoli/comune/actual.yaml": JSON.stringify(misplaced),
  });
  const errors = validateDir(dir, ctx.registry, "2026-10-25").flatMap((r) => r.errors).join("\n");
  assert.match(errors, /related "napoli\/comune\/claimed" is not a procedure/);
  assert.match(errors, /must match its path "napoli\/comune\/actual"/);
});

test("a %YAML version directive is refused", () => {
  const dir = tempLibrary({ "napoli/comune/test.yaml": `%YAML 1.1\n---\n${VALID_YAML}\n` });
  const [result] = validateDir(dir, ctx.registry, "2026-10-25");
  assert.deepEqual(result.errors, ["remove the %YAML directive: procedures are read as YAML 1.2"]);
});

test("personal data in YAML comments is caught", () => {
  const dir = tempLibrary({ "napoli/comune/test.yaml": `# intestatario RSSMRA85T10A562S\n${VALID_YAML}\n` });
  const [result] = validateDir(dir, ctx.registry, "2026-10-25");
  assert.match(result.errors.join("\n"), /line 1: comment looks like it has a codice fiscale/);
});

function runCli(dir: string) {
  return spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "tools", "validate.ts"), dir], {
    encoding: "utf8",
    cwd: ROOT,
  });
}

test("CLI exit codes: valid, invalid, empty and missing directories", () => {
  assert.equal(runCli(tempLibrary({ "napoli/comune/test.yaml": VALID_YAML })).status, 0);
  const bad = runCli(tempLibrary({ "napoli/comune/test.yaml": VALID_YAML, "napoli/comune/broken.yaml": "id: [" }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /✗ napoli[\\/]comune[\\/]broken\.yaml/);
  const empty = runCli(tempLibrary({}));
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no procedures found/);
  const missing = runCli(path.join(tmpdir(), "does-not-exist-pratiche"));
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /procedures directory not found/);
});

// --- second review: regressions ---

test("comments in CRLF and CR-only files are still scanned", () => {
  for (const eol of ["\r\n", "\r"]) {
    const dir = tempLibrary({ "napoli/comune/test.yaml": `# intestatario RSSMRA85T10A562S${eol}${VALID_YAML}${eol}` });
    const [result] = validateDir(dir, ctx.registry, "2026-10-25");
    assert.match(result.errors.join("\n"), /comment looks like it has a codice fiscale/, JSON.stringify(eol));
  }
});

test("every credential word the vault knows is refused", () => {
  for (const name of ["cie_pin1", "cie_puk2", "spid_pwd", "spid_pw", "spid_pass", "spid_passcode", "cieid_totp",
    "spid_username", "spid_login", "cie_segreto", "spid_chiave", "api_token", "spid_password", "cie_otp"]) {
    assert.match(checkFieldRef(`documents.${name}`, ctx.registry) ?? "", /secret/, name);
  }
  assert.match(errorsFor(withForm({ label: "X", map: { repeat: "famiglia", fields: ["*:documents.spid_username"] } })), /secret/);
});

test("a wildcard over an open category is refused", () => {
  assert.match(checkFieldRef("documents.*", ctx.registry) ?? "", /open category/);
  assert.equal(checkFieldRef("residenza.*", ctx.registry), null);
});

test("ask and blank_with_reason can't request secrets, but form names like PIN 2.1 are fine", () => {
  assert.match(errorsFor(withForm({ label: "X", map: { ask: "PIN della CIE e password SPID del titolare" } })), /must not ask for a PIN/);
  assert.match(errorsFor(withForm({ label: "X", map: { blank_with_reason: "Inserire il codice OTP" } })), /must not ask for a PIN/);
  assert.deepEqual(validateProcedure(withForm({ label: "X", map: { blank_with_reason: "Allegare il modulo PIN 2.1" } }), PATH, ctx), []);
});

test("URLs need a host", () => {
  for (const url of ["https://", "http://", "https:///", "https://?x"]) {
    const doc = minimal();
    doc.sources[0].url = url;
    assert.match(errorsFor(doc), /schema: \/sources\/0\/url must match pattern/, url);
  }
});

test("blank codes and notes are rejected", () => {
  const doc = minimal();
  doc.payment = { method: "f24", codice_ente: " ", rateazione: "" };
  doc.channels[0].notes = "  ";
  const errors = errorsFor(doc);
  assert.match(errors, /\/payment\/codice_ente/);
  assert.match(errors, /\/payment\/rateazione/);
  assert.match(errors, /\/channels\/0\/notes/);
});

test("two files with the same id are both reported", () => {
  const dir = tempLibrary({ "napoli/comune/test.yaml": VALID_YAML, "napoli/comune/test.yml": VALID_YAML });
  const results = validateDir(dir, ctx.registry, "2026-10-25");
  assert.equal(results.length, 2);
  for (const r of results) assert.match(r.errors.join("\n"), /another file has the same id/);
});

test("a byte-order mark doesn't hide a %YAML directive", () => {
  const dir = tempLibrary({ "napoli/comune/test.yaml": `﻿%YAML 1.1\n---\n${VALID_YAML}\n` });
  const [result] = validateDir(dir, ctx.registry, "2026-10-25");
  assert.deepEqual(result.errors, ["remove the %YAML directive: procedures are read as YAML 1.2"]);
});

test("a broken symlink is reported and symlinked directories are followed", () => {
  const dir = tempLibrary({ "napoli/comune/test.yaml": VALID_YAML });
  symlinkSync(path.join(dir, "nowhere.yaml"), path.join(dir, "napoli/comune/broken.yaml"));
  const other = tempLibrary({ "other.yaml": JSON.stringify({ ...minimal(), id: "napoli/linked/other" }) });
  symlinkSync(other, path.join(dir, "napoli/linked"));
  const byFile = Object.fromEntries(validateDir(dir, ctx.registry, "2026-10-25").map((r) => [r.rel.replace(/\\/g, "/"), r.errors.join("\n")]));
  assert.match(byFile["napoli/comune/broken.yaml"], /can't read file/);
  assert.equal(byFile["napoli/linked/other.yaml"], "");
});

test("validating part of the library keeps ids and links in context", () => {
  const linking = { ...minimal(), id: "napoli/comune/test", related: ["napoli/altro/other"] };
  const dir = tempLibrary({
    "napoli/comune/test.yaml": JSON.stringify(linking),
    "napoli/altro/other.yaml": JSON.stringify({ ...minimal(), id: "napoli/altro/other" }),
  });
  const results = validateDir(dir, ctx.registry, "2026-10-25", path.join(dir, "napoli/comune"));
  assert.deepEqual(results.map((r) => [r.rel.replace(/\\/g, "/"), r.errors]), [["napoli/comune/test.yaml", []]]);
});

test("CLI: a subdirectory of the real library validates in context", () => {
  const sub = runCli(path.join(ROOT, "procedures", "napoli", "comune"));
  assert.equal(sub.status, 0, sub.stderr);
  assert.doesNotMatch(sub.stdout + sub.stderr, /must match its path/);
});

test("registry ids all match the schema's field reference pattern", () => {
  const schema = JSON.parse(readFileSync(path.join(ROOT, "contract", "procedure.schema.json"), "utf8"));
  const pattern = new RegExp(schema.$defs.fieldRef.pattern);
  for (const c of ctx.registry.categories) for (const f of c.fields) assert.match(f.id, pattern, f.id);
});

test("extension entries are validated", () => {
  const schema: VaultSchema = { version: "1", categories: [
    { name: "business", description: "", scope: "person", fields: [{ id: "business.partita_iva", description: "", sensitivity: "standard" }] },
    { name: "cie", description: "", scope: "person", fields: [
      { id: "cie.numero", description: "", sensitivity: "sensitive" },
      { id: "cie.pin", description: "", sensitivity: "critical" },
    ] },
  ] };
  const ext = (categories: any[]) => () => buildRegistry(schema, { categories });
  assert.throws(ext([{ name: "business", fields: [{ id: "business.E-mail", description: "" }] }]), /must look like category.field_name/);
  assert.throws(ext([{ name: "business", fields: [{ id: "business.*", description: "" }] }]), /must look like category.field_name/);
  assert.throws(ext([{ name: "locale2", description: "x", fields: [] }]), /lower-case name/);
  assert.throws(ext([{ name: "business" }]), /fields list/);
  assert.throws(ext([{ name: "business", fields: [{ id: "business.spid_pin1", description: "" }] }]), /looks like a credential/);
  assert.throws(ext([{ name: "cie", fields: [{ id: "cie.pin", description: "" }] }]), /is a secret field in the vault/);
});

test("empty vault categories are secret unless listed as open", () => {
  const reg = buildRegistry({ version: "1", categories: [
    { name: "documents", description: "", scope: "person", fields: null },
    { name: "carte", description: "", scope: "person", fields: [] },
  ] });
  assert.deepEqual(reg.categories.map((c) => c.name), ["documents"]);
  assert.ok(reg.forbidden.categories.includes("carte"));
  assert.match(checkFieldRef("carte.numero", reg) ?? "", /secret/);
});

test("gen-fields runs when invoked through a symlinked path", () => {
  const link = path.join(mkdtempSync(path.join(tmpdir(), "genlink-")), "tools");
  symlinkSync(path.join(ROOT, "tools"), link);
  const before = readFileSync(FIELDS_PATH, "utf8");
  const run = spawnSync(process.execPath, ["--import", "tsx", path.join(link, "gen-fields.ts")], { encoding: "utf8", cwd: ROOT });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /wrote/);
  assert.equal(readFileSync(FIELDS_PATH, "utf8"), before);
});
