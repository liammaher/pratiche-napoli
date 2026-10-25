import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { FIELDS_PATH, VAULT_SCHEMA_PATH, buildRegistry, renderRegistry } from "./gen-fields.ts";
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
    { label: "Conviventi", map: { repeat: "nucleo_familiare.membro<N>_*" } },
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

test("wildcards can't sweep in secret fields", () => {
  for (const map of [
    { direct: "cie.*" },
    { concat: ["cie.*", "identity.email"] },
    { fallback: ["financial.*", "identity.email"] },
  ]) {
    assert.match(errorsFor(withForm({ label: "X", map })), /secret or payment field/, JSON.stringify(map));
  }
});

test("credential-like names are refused in open and per-item categories", () => {
  for (const ref of ["documents.cie_pin", "documents.spid_password", "documents.otp"]) {
    assert.match(checkFieldRef(ref, ctx.registry) ?? "", /secret/, ref);
  }
  assert.match(errorsFor(withForm({ label: "X", map: { repeat: "nucleo_familiare.membro<N>_cie_pin" } })), /secret/);
});

test("per-item patterns must follow the category template and only appear in repeat", () => {
  const r = ctx.registry;
  assert.equal(checkFieldRef("nucleo_familiare.membro<N>_nome", r), null);
  assert.equal(checkFieldRef("nucleo_familiare.membro2_nome", r), null);
  assert.equal(checkFieldRef("nucleo_familiare.numero_componenti", r), null);
  assert.match(checkFieldRef("nucleo_familiare.<N>", r) ?? "", /doesn't follow the pattern/);
  assert.match(checkFieldRef("nucleo_familiare.membro_nome", r) ?? "", /doesn't follow the pattern/);
  assert.match(checkFieldRef("pratiche.slug_stato", r) ?? "", /unknown category "pratiche"/);
  assert.match(errorsFor(withForm({ label: "X", map: { direct: "nucleo_familiare.membro<N>_nome" } })), /only be used with repeat/);
  assert.match(errorsFor(withForm({ label: "X", map: { repeat: "identity.email" } })), /repeat needs a per-item pattern/);
});

test("field refs: categories, wildcards and forbidden fields", () => {
  const r = ctx.registry;
  assert.equal(checkFieldRef("business.partita_iva", r), null);
  assert.equal(checkFieldRef("residenza.*", r), null);
  assert.equal(checkFieldRef("documents.anything", r), null); // open category
  assert.match(checkFieldRef("identity.membro<N>_nome", r) ?? "", /no per-item fields/);
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
      { name: "cie", description: "", fields: [
        { id: "cie.numero", description: "", sensitivity: "sensitive" },
        { id: "cie.pin", description: "", sensitivity: "critical" },
        { id: "cie.new_tier", description: "", sensitivity: "Critical" },
      ] },
      { name: "spid", description: "", fields: [{ id: "spid.password", description: "", sensitivity: "personal" }] },
      { name: "cieid", description: "", fields: [
        { id: "cieid.password", description: "", sensitivity: "personal" },
        { id: "cieid.otp_seed", description: "", sensitivity: "critical" },
      ] },
      { name: "pratiche", description: "", fields: [] },
      { name: "nucleo_familiare", description: "", fields: [] },
      { name: "documents", description: "", fields: null },
    ],
  });
  assert.deepEqual(reg.categories.map((c) => c.name), ["cie", "nucleo_familiare", "documents"]);
  assert.deepEqual(reg.categories[0].fields.map((f) => f.id), ["cie.numero"]);
  assert.deepEqual(reg.forbidden.fields, ["cie.new_tier", "cie.pin", "cieid.otp_seed", "cieid.password"]);
  assert.ok(reg.forbidden.categories.includes("cieid"));
  assert.equal(reg.categories[1].dynamic, "membro<N>_<campo>");
  assert.equal(reg.categories[2].open, true);
  assert.equal(checkFieldRef("cieid.otp_seed2", reg), "cieid.otp_seed2 can't be used in a public procedure: it is (or includes) a secret or payment field");
});

test("registry rejects malformed vault schemas", () => {
  assert.throws(() => buildRegistry({ version: "9" } as any), /not a vault schema/);
  assert.throws(
    () => buildRegistry({ version: "1", categories: [{ name: "x", description: "", fields: [{ id: "y.z", description: "", sensitivity: "standard" }] }] }),
    /listed under category "x"/,
  );
});

test("fields.json is exactly what gen-fields builds from the saved vault schema", () => {
  const schema = JSON.parse(readFileSync(VAULT_SCHEMA_PATH, "utf8"));
  assert.equal(readFileSync(FIELDS_PATH, "utf8"), renderRegistry(schema), "run npm run gen:fields");
});

test("every registry field is usable and every forbidden one is refused", () => {
  const reg = ctx.registry;
  for (const c of reg.categories) for (const f of c.fields) assert.equal(checkFieldRef(f.id, reg), null, f.id);
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
