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
  validateSituations,
  type Context,
} from "./lib/validate.ts";

const ctx: Context = {
  registry: loadRegistry(),
  knownIds: new Set(["napoli/comune/test", "napoli/comune/other"]),
  today: "2026-10-25",
};
const PATH = "procedures/napoli/comune/test.yaml";
// The vault's credential words, which every schema the tests build carries.
const WORDS: VaultSchema["credentials"] = JSON.parse(readFileSync(VAULT_SCHEMA_PATH, "utf8")).credentials;

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
    channels: [{ type: "pec", purpose: "procedure", address: "ufficio@pec.comune.napoli.it" }],
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
    { label: "Indirizzo", map: { fallback: ["domicilio.*", "residenza.*"] }, notes: "Tutto dal domicilio o tutto dalla residenza." },
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

test("an address is taken whole from one place: a person's own, saying so, or the business's", () => {
  const ok = withForm(
    { label: "Via", map: { fallback: ["domicilio.indirizzo", "residenza.indirizzo"] }, notes: "Tutto dalla stessa fonte." },
    { label: "PEC", map: { fallback: ["identity.pec", "identity.email"] } },
  );
  assert.deepEqual(validateProcedure(ok, PATH, ctx), []);
  const errors = errorsFor(
    withForm(
      { label: "Int.", map: { fallback: ["domicilio.interno", "residenza.interno"] } },
      { label: "Via", map: { fallback: ["locale.indirizzo", "residenza.indirizzo"] }, notes: "Tutto dalla stessa fonte." },
      { label: "Sede", map: { fallback: ["business.sede_legale_comune", "residenza.comune"] }, notes: "Tutto dalla stessa fonte." },
      { label: "Indirizzo", map: { concat: ["domicilio.indirizzo", "residenza.civico"] } },
    ),
  );
  assert.match(errors, /field "Int.": fallback from domicilio to residenza needs notes saying the whole address comes from the same one/);
  assert.match(errors, /field "Via": fallback mixes locale and residenza: an address is a person's home or the business's, never a field from each/);
  assert.match(errors, /field "Sede": fallback mixes sede legale and residenza/);
  assert.match(errors, /field "Indirizzo": concat joins domicilio and residenza: an address's parts come from one place/);
  // One place's parts, joined, are fine.
  assert.deepEqual(validateProcedure(withForm({ label: "Sede", map: { concat: ["business.sede_legale_indirizzo", "business.sede_legale_civico"] } }), PATH, ctx), []);
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
  assert.match(errorsFor(member), /records: famiglia.relazione is another person's field, never the vault owner's/);
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
  assert.match(checkFieldRef("famiglia.relazione", r) ?? "", /another person's field, never the vault owner's/);
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
  assert.match(row(["identity.first_name"]), /each row is filled from that person's fields, written \*:category.field/);
  assert.match(row(["tari.codice_contribuente"]), /each row is filled from that person's fields/);
  assert.match(row(["io:identity.first_name"]), /"io" is reserved/);
  assert.match(errorsFor(withForm({ label: "X", map: { direct: "io:identity.first_name" } })), /"io" is reserved/);
  assert.match(row(["leo:identity.first_name"]), /can't name a particular person \("leo"\)/);
  assert.match(row(["*:tari.codice_contribuente"]), /vault owner's/);
  assert.match(errorsFor(withForm({ label: "X", map: { direct: "*:identity.first_name" } })), /only repeat can fill/);
  assert.match(
    errorsFor(withForm({ label: "X", map: { concat: ["leo:identity.last_name", "identity.first_name"] } })),
    /can't name a particular person/,
  );
  assert.match(errorsFor(withForm({ label: "X", map: { direct: "nucleo_familiare.membro1_nome" } })), /unknown category "nucleo_familiare"/);
  assert.match(errorsFor(withForm({ label: "X", map: { direct: "pratiche.slug_stato" } })), /unknown category "pratiche"/);
});

test("repeat takes famiglia or { ruolo }, with fields, and <N> patterns are refused", () => {
  for (const map of [
    { repeat: "nucleo_familiare.membro<N>_*" },
    { repeat: "famiglia" },
    { repeat: { ruolo: "socio" } },
    { repeat: { ruolo: "cugino" }, fields: ["*:identity.last_name"] },
    { repeat: { ruolo: [] }, fields: ["*:identity.last_name"] },
    { repeat: { ruolo: "socio", except: "titolare" }, fields: ["*:identity.last_name"] },
    { repeat: "socio", fields: ["*:identity.last_name"] },
    { repeat: "famiglia", fields: [] },
    { repeat: "identity.email", fields: ["*:identity.email"] },
    { repeat: "famiglia", fields: ["*:identity.first_name", "*:identity.first_name"] },
    { direct: "nucleo_familiare.membro<N>_nome" },
    { direct: "Leo:identity.first_name" },
  ]) {
    assert.match(errorsFor(withForm({ label: "X", map })), /must be exactly one of/, JSON.stringify(map));
  }
});

test("party reads a person picked by ruolo, written without a prefix", () => {
  const ok = (map: Record<string, unknown>) => assert.deepEqual(validateProcedure(withForm({ label: "X", map }), PATH, ctx), [], JSON.stringify(map));
  const bad = (map: Record<string, unknown>, re: RegExp) => assert.match(errorsFor(withForm({ label: "X", map })), re, JSON.stringify(map));
  const procuratore = { ruolo: "procuratore" };
  ok({ party: procuratore, direct: "identity.codice_fiscale" });
  ok({ party: { ruolo: ["socio", "amministratore"] }, concat: ["identity.last_name", "identity.first_name"] });
  ok({ party: procuratore, fallback: ["identity.pec", "identity.email"] });
  ok({ party: { ruolo: "preposto" }, direct: "ruolo.data_inizio" }); // the person's own ruolo
  ok({ party: procuratore, direct: "business.denominazione" }); // a company can be a party
  ok({ party: procuratore, direct: "residenza.*" });

  bad({ party: procuratore, direct: "*:identity.last_name" }, /inside party, write the field without a prefix/);
  bad({ party: procuratore, concat: ["leo:identity.last_name", "identity.first_name"] }, /inside party, write the field without a prefix/);
  bad({ party: procuratore, direct: "tari.codice_contribuente" }, /tari is the vault owner's \(the household's\); the person with that ruolo can't have it/);
  bad({ party: procuratore, direct: "famiglia.intestatario_scheda" }, /owner's field only; the person with that ruolo can't have it/);
  bad({ party: procuratore, direct: "famiglia.relazione" }, /famiglia is only in personal vaults, and people with a ruolo are in a business vault/);
  bad({ party: procuratore, direct: "business.qualita_dichiarante" }, /business.qualita_dichiarante is only in personal vaults/);
  bad({ party: procuratore, direct: "cie.pin" }, /secret/);
  bad({ party: procuratore, direct: "identity.shoe_size" }, /unknown field "identity.shoe_size"/);

  for (const map of [
    { party: { ruolo: "cugino" }, direct: "identity.last_name" },
    { party: {}, direct: "identity.last_name" },
    { party: "procuratore", direct: "identity.last_name" },
    { party: { ruolo: "socio", slug: "leo" }, direct: "identity.last_name" },
    { party: procuratore, ask: "Nome del procuratore" },
    { party: procuratore, repeat: "famiglia", fields: ["*:identity.last_name"] },
  ]) {
    assert.match(errorsFor(withForm({ label: "X", map })), /must be exactly one of/, JSON.stringify(map));
  }
});

test("repeat by ruolo fills one row per person with it, from what a business vault keeps", () => {
  const doc = withForm({
    label: "Allegato A",
    map: { repeat: { ruolo: ["socio", "amministratore"], except: "dichiarante" }, fields: ["*:identity.last_name", "*:ruolo.quota_percentuale"] },
  });
  doc.dichiarante = { ruolo: "legale_rappresentante" };
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);
  delete doc.dichiarante;
  assert.match(errorsFor(doc), /except: dichiarante needs the procedure's dichiarante/);

  const row = (repeat: unknown, fields: string[]) => errorsFor(withForm({ label: "X", map: { repeat, fields } }));
  assert.equal(row({ ruolo: "socio" }, ["*:identity.codice_fiscale", "*:ruolo.data_inizio"]), "");
  assert.match(row({ ruolo: "socio" }, ["*:famiglia.relazione"]), /famiglia is only in personal vaults/);
  assert.match(row({ ruolo: "socio" }, ["identity.last_name"]), /each row is filled from that person's fields/);
  assert.match(row("famiglia", ["*:ruolo.tipo"]), /ruolo is only in business vaults, and family members are in a personal vault/);
  assert.match(row("famiglia", ["*:business.qualita_dichiarante"]), /^$/); // a member's own business, in a personal vault
});

test("a procura is read only from someone who gives one: a cliente, or a family member", () => {
  const map = (m: Record<string, unknown>) => errorsFor(withForm({ label: "X", map: m }));
  assert.equal(map({ party: { ruolo: "cliente" }, direct: "procura.ente" }), "");
  assert.equal(map({ party: { ruolo: "cliente" }, concat: ["procura.oggetto", "procura.data_scadenza"] }), "");
  assert.equal(map({ repeat: { ruolo: "cliente" }, fields: ["*:identity.last_name", "*:procura.data_scadenza"] }), "");
  assert.equal(map({ repeat: "famiglia", fields: ["*:procura.ente"] }), ""); // a parent's delega
  // The procuratore holds the business's procura, not one they gave it.
  assert.match(map({ party: { ruolo: "procuratore" }, direct: "procura.ente" }), /procura is one a person gave the business.*from ruolo cliente, not procuratore/);
  assert.match(map({ party: { ruolo: "procuratore" }, fallback: ["identity.pec", "procura.oggetto"] }), /not procuratore/);
  assert.match(map({ party: { ruolo: ["cliente", "socio"] }, direct: "procura.*" }), /not socio$/);
  assert.match(map({ repeat: { ruolo: ["procuratore", "cliente"] }, fields: ["*:procura.data_scadenza"] }), /not procuratore$/);
  // Other fields of the same people are unaffected.
  assert.equal(map({ party: { ruolo: "procuratore" }, direct: "identity.codice_fiscale" }), "");
});

test("with a dichiarante, a person's own data is theirs and the rest stays the vault owner's", () => {
  const fields = [
    { label: "Cognome", map: { direct: "identity.last_name" } },
    { label: "Residenza", map: { concat: ["residenza.indirizzo", "residenza.civico"] } },
    { label: "Permesso", map: { direct: "permesso_soggiorno.numero" } },
    { label: "In qualità di", map: { fallback: ["business.qualita_dichiarante", "ruolo.tipo"] } },
    { label: "Ditta", map: { direct: "business.denominazione" } },
    { label: "Locale", map: { direct: "locale.indirizzo" } },
    { label: "TARI", map: { direct: "tari.codice_contribuente" } }, // the owner's household, never rebound
  ];
  const doc = withForm(...fields);
  doc.dichiarante = { ruolo: ["titolare", "legale_rappresentante"] };
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);

  delete doc.dichiarante;
  assert.match(errorsFor(doc), /ruolo.tipo is another person's field, never the vault owner's/);

  // The dichiarante is a personal vault's owner or a person with a ruolo, so
  // a field either of them has is fine, one neither has is not.
  const signed = (map: Record<string, unknown>) => {
    const d = withForm({ label: "X", map });
    d.dichiarante = { ruolo: "titolare" };
    return errorsFor(d);
  };
  assert.equal(signed({ direct: "famiglia.intestatario_scheda" }), "");
  assert.equal(signed({ direct: "ruolo.*" }), "");
  for (const ref of ["famiglia.relazione", "famiglia.stato_famiglia"]) {
    assert.match(signed({ direct: ref }), /no dichiarante can have it, neither the owner of a personal vault nor a person with a ruolo/, ref);
  }
  assert.match(signed({ direct: "identity.shoe_size" }), /unknown field "identity.shoe_size"/);
  assert.match(signed({ direct: "cie.pin" }), /secret/);

  // records are read the same way.
  const rec = minimal();
  rec.records = [{ field: "ruolo.data_inizio", from: "Atto di nomina" }];
  assert.match(errorsFor(rec), /records: ruolo.data_inizio is another person's field/);
  rec.dichiarante = { ruolo: "titolare" };
  assert.equal(errorsFor(rec), "");
  rec.records.push({ field: "famiglia.relazione", from: "Modulo" });
  assert.match(errorsFor(rec), /records: famiglia.relazione: no dichiarante can have it/);

  for (const dichiarante of [{ ruolo: "boss" }, "titolare", { ruolo: [] }, {}]) {
    const d = minimal();
    d.dichiarante = dichiarante;
    assert.match(errorsFor(d), /schema: \/dichiarante/, JSON.stringify(dichiarante));
  }
  // Only someone who signs for the business: never a client's, a supplier's
  // or an employee's identity on the business's declarations.
  for (const ruolo of ["cliente", ["fornitore", "dipendente"], ["titolare", "procuratore"]]) {
    const d = minimal();
    d.applies_to.audience = ["business"];
    d.dichiarante = { ruolo };
    assert.match(errorsFor(d), /schema: \/dichiarante\/ruolo/, JSON.stringify(ruolo));
  }
});

test("the schema's ruolo list is the vault's ruolo.tipo list", () => {
  const vault = JSON.parse(readFileSync(VAULT_SCHEMA_PATH, "utf8")) as VaultSchema;
  const tipo = vault.categories.find((c) => c.name === "ruolo")!.fields!.find((f) => f.id === "ruolo.tipo")!;
  const listed = tipo.description.match(/one or more of: ([a-z_, ]+?) \(/)?.[1].split(", ");
  const schema = JSON.parse(readFileSync(path.join(ROOT, "contract", "procedure.schema.json"), "utf8"));
  assert.deepEqual(schema.$defs.ruolo.enum, listed, "update $defs.ruolo in procedure.schema.json");
  // Who may sign is a few of them.
  for (const signer of schema.$defs.signer.enum) assert.ok(listed!.includes(signer), signer);
});

test("field refs: categories, wildcards and forbidden fields", () => {
  const r = ctx.registry;
  // A wildcard can't be only fields its holder never has.
  assert.match(checkFieldRef("ruolo.*", r) ?? "", /every ruolo field is another person's, never the vault owner's/);
  assert.equal(checkFieldRef("*:ruolo.*", r), null);
  assert.equal(checkFieldRef("famiglia.*", r), null); // has the owner's intestatario_scheda
  assert.equal(checkFieldRef("business.partita_iva", r), null);
  assert.equal(checkFieldRef("residenza.*", r), null);
  assert.equal(checkFieldRef("documents.anything", r), null); // open category
  assert.match(checkFieldRef("cie.pin", r) ?? "", /secret/);
  assert.match(checkFieldRef("nope.field", r) ?? "", /unknown category/);
});

test("a malformed mapping gives one readable error", () => {
  for (const map of [
    { ask: "a", direct: "identity.email" },
    { concat: ["Identity.Email"] },
    { party: { ruolo: "cugino" }, direct: "identity.last_name" },
    { party: { ruolo: ["socio", "cugino"] }, concat: ["identity.last_name", "identity.first_name"] },
    { repeat: { ruolo: "socio", except: "titolare" }, fields: ["*:identity.last_name"] },
  ]) {
    const errors = validateProcedure(withForm({ label: "X", map }), PATH, ctx);
    assert.equal(errors.length, 1, JSON.stringify(errors));
    assert.match(errors[0], /^schema: \/forms\/0\/fields\/0\/map must be exactly one of direct, concat/);
  }
});

test("verified claims need an official source, and sources must exist", () => {
  const doc = minimal();
  doc.sources.push({ id: "blog", label: "Un blog", retrieved: "2026-10-25" });
  doc.deadline = {
    summary: { text: "Dipende dal caso", status: "unverified" },
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

test("a procedure needs a channel that carries it out", () => {
  const doc = minimal();
  doc.channels.push({ type: "email", purpose: "info", preferred: true });
  assert.match(errorsFor(doc), /channels\/1: preferred marks the recommended way/);
  doc.channels.pop();
  doc.channels[0].purpose = "info";
  assert.match(errorsFor(doc), /channels: at least one must have purpose "procedure"/);
  delete doc.channels[0].purpose;
  assert.match(errorsFor(doc), /schema: \/channels\/0 must have required property 'purpose'/);
});

test("several deadline rules need a summary for In breve", () => {
  const doc = minimal();
  const rule = { text: "Entro 30 giorni.", status: "verified", source: "page" };
  doc.deadline = { rules: [rule] };
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);
  doc.deadline.rules.push({ text: "Per le società entro 15 giorni.", status: "verified", source: "page" });
  assert.match(errorsFor(doc), /deadline: with more than one rule, add a summary covering every case/);
  doc.deadline.summary = { text: "Entro 30 giorni; per le società entro 15.", status: "verified" };
  assert.match(errorsFor(doc), /\/deadline\/summary\/status: a verified claim must cite a source/);
  doc.deadline.summary.source = "page";
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);
});

test("the reported block is checked against the schema and the procedure", () => {
  const doc = minimal();
  doc.documents = [{ name: "Modulo", required: true }];
  doc.reported = {
    generated: "2026-10-25",
    period: { from: "2026-01", to: "2026-09" },
    count: 3,
    channels: [{ type: "pec", count: 3, days_to_answer: { median: 20, n: 3 } }],
    documents: [{ name: "Modulo", asked: 3, of: 3 }],
    basis: ["0123456789ab", "123456789abc", "23456789abcd"],
  };
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);

  // A smallest or largest value is one person's; so is a count of 1 or 2,
  // given directly or left over beside the total.
  doc.reported.channels[0].days_to_answer.min = 9;
  assert.match(errorsFor(doc), /days_to_answer must NOT have additional properties/);
  delete doc.reported.channels[0].days_to_answer.min;
  doc.reported.documents = [{ name: "Modulo", asked: 2, of: 3 }];
  assert.match(errorsFor(doc), /\/reported\/documents\/0\/asked/);
  doc.reported.documents = [{ name: "Modulo", asked: 3, of: 4 }];
  assert.match(errorsFor(doc), /reported document "Modulo": those not asked must be none or at least 3/);
  doc.reported.documents = [{ name: "Modulo", asked: 3, of: 3 }];
  doc.reported.count = 4;
  doc.reported.basis.push("3456789abcde");
  doc.reported.outcomes = { completata: 3 };
  let errors = errorsFor(doc);
  assert.match(errors, /reported outcomes leave 1 or 2 reports over/);
  assert.match(errors, /reported channels leave 1 or 2 reports over/);
  doc.reported.basis.pop();
  assert.match(errorsFor(doc), /reported basis has 3 reports, but count is 4/);
  doc.reported.count = 3;
  doc.reported.outcomes = { completata: 3 };
  // A figure answered by 3 of 4 points at the fourth.
  doc.reported.count = 4;
  doc.reported.basis.push("3456789abcde");
  doc.reported.outcomes = { completata: 4 };
  doc.reported.channels[0].count = 4;
  doc.reported.paid_eur = { median: 15, n: 3 };
  doc.reported.rejection_reasons = [{ text: "Manca la firma", count: 3 }];
  errors = errorsFor(doc);
  assert.match(errors, /reported paid_eur: those who didn't answer must be none or at least 3/);
  assert.match(errors, /reported channels\/0\/days_to_answer: those who didn't answer/);
  assert.match(errors, /reported document "Modulo": those who didn't say/);
  assert.match(errors, /reported rejection_reasons need the count of refusals/);
  // Two texts of 3 out of 7: each leaves 4, but together they leave 1.
  doc.reported.count = 7;
  doc.reported.extra_documents = [
    { text: "Planimetria", count: 3 },
    { text: "Visura storica", count: 3 },
  ];
  assert.match(errorsFor(doc), /reported extra_documents leave 1 or 2 reports over beside the count/);
  delete doc.reported.extra_documents;
  doc.reported.count = 3;
  doc.reported.basis.pop();
  doc.reported.outcomes = { completata: 3 };
  doc.reported.channels[0].count = 3;
  delete doc.reported.paid_eur;
  delete doc.reported.rejection_reasons;

  doc.reported.channels[0].days_to_answer.n = 2;
  assert.match(errorsFor(doc), /schema: \/reported\/channels\/0\/days_to_answer\/n must be >= 3/);
  doc.reported.channels[0].days_to_answer.n = 3;

  doc.reported.documents = [{ name: "Altro", asked: 4, of: 3 }];
  doc.reported.period = { from: "2026-10", to: "2026-09" };
  doc.reported.generated = "2026-10-26";
  errors = errorsFor(doc);
  assert.match(errors, /reported document "Altro" is not in documents/);
  assert.match(errors, /reported document "Altro" was asked more often than reported/);
  assert.match(errors, /reported period starts after it ends/);
  assert.match(errors, /reported was generated in the future/);
  assert.match(errors, /updated 2026-10-25 is older than reported \(2026-10-26\)/);
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
    version: "1", credentials: WORDS,
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

test("registry keeps each category's subject and kinds, and each field's kinds", () => {
  const reg = buildRegistry({
    version: "1", credentials: WORDS,
    categories: [
      { name: "ruolo", description: "", scope: "person", kinds: ["impresa"], fields: [{ id: "ruolo.tipo", description: "", sensitivity: "standard", for: "member" }] },
      { name: "business", description: "", scope: "person", subject: "impresa", fields: [
        { id: "business.qualita_dichiarante", description: "", sensitivity: "standard", kinds: ["persona"] },
        { id: "business.pec", description: "", sensitivity: "standard" },
      ] },
    ],
  });
  assert.deepEqual(reg.categories.map((c) => [c.name, c.subject, c.kinds]), [["ruolo", undefined, ["impresa"]], ["business", "impresa", undefined]]);
  assert.deepEqual(reg.categories[1].fields.map((f) => [f.id, f.kinds]), [["business.qualita_dichiarante", ["persona"]], ["business.pec", undefined]]);
  assert.equal("kinds" in reg.categories[1].fields[1], false);

  const one = (cat: Record<string, unknown>) => () => buildRegistry({ version: "1", credentials: WORDS, categories: [{ name: "x", description: "", scope: "person", fields: [], ...cat }] } as any);
  assert.throws(one({ subject: "azienda" }), /"x" has subject "azienda"/);
  assert.throws(one({ kinds: ["studio"] }), /category "x" has kinds \["studio"\]/);
  assert.throws(one({ kinds: [] }), /category "x" has kinds \[\]/);
  assert.throws(one({ kinds: ["persona", "persona"] }), /has kinds/);
  assert.throws(one({ fields: [{ id: "x.y", description: "", sensitivity: "standard", kinds: "persona" }] }), /field "x.y" has kinds "persona"/);
});

test("registry rejects malformed vault schemas", () => {
  assert.throws(() => buildRegistry({ version: "9" } as any), /not a vault schema/);
  // The credential words come from the vault, never a copy kept here.
  const words = (credentials: unknown) => () => buildRegistry({ version: "1", categories: [], credentials } as any);
  assert.throws(words(undefined), /credentials.secret must be a whole-word pattern/);
  assert.throws(words({ ...WORDS, credential: "pin" }), /credentials.credential must be a whole-word pattern/);
  assert.throws(words({ ...WORDS, identity: "^(?<x$" }), /Invalid regular expression/);
  assert.equal(buildRegistry({ version: "1", categories: [], credentials: WORDS }).credential_word, WORDS.credential);
  assert.throws(
    () => buildRegistry({ version: "1", credentials: WORDS, categories: [{ name: "x", description: "", scope: "person", fields: [{ id: "y.z", description: "", sensitivity: "standard" }] }] }),
    /listed under category "x"/,
  );
  assert.throws(() => buildRegistry({ version: "1", credentials: WORDS, categories: [{ name: "x", description: "", fields: [] }] } as any), /"x" needs a scope/);
  assert.throws(
    () => buildRegistry({ version: "1", credentials: WORDS, categories: [{ name: "x", description: "", scope: "person", fields: [{ id: "x.y", description: "", sensitivity: "standard", for: "child" }] }] } as any),
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
    version: "1", credentials: WORDS,
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

  // A new category may say what it describes and where it exists; a vault one keeps the vault's.
  const req = buildRegistry(schema, {
    categories: [{ name: "requisito", description: "x", scope: "person", subject: "persona", kinds: ["impresa"], fields: [{ id: "requisito.tipo", description: "", kinds: ["impresa"] }] }],
  }).categories.find((c) => c.name === "requisito")!;
  assert.deepEqual([req.subject, req.kinds, req.fields[0].kinds], ["persona", ["impresa"], ["impresa"]]);
  assert.throws(ext([{ name: "nuova", description: "x", scope: "person", subject: "azienda", fields: [] }]), /has subject "azienda"/);
  assert.throws(ext([{ name: "nuova", description: "x", scope: "person", fields: [{ id: "nuova.x", description: "", kinds: ["x"] }] }]), /"nuova.x" has kinds/);
  assert.throws(ext([{ name: "business", subject: "persona", fields: [] }]), /can't change the scope, subject or kinds of vault category "business"/);
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
    "spid_username", "spid_login", "cie_segreto", "spid_chiave", "api_token", "spid_password", "cie_otp",
    "pincode", "codice_sblocco", "credenziali", "parola-segreta", "passwords", "password2", "spid_chiavi"]) {
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
  const schema: VaultSchema = { version: "1", credentials: WORDS, categories: [
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
  const reg = buildRegistry({ version: "1", credentials: WORDS, categories: [
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

const SITUATION = {
  schema_version: 0,
  id: "apro-test",
  headline: "Aprire un test a Napoli: le pratiche",
  updated: "2026-10-25",
  intro: "Le pratiche di chi apre un test.",
  steps: [
    { procedure: "napoli/comune/test", when: "La prima" },
    { procedure: "napoli/comune/other", when: "La seconda" },
  ],
};

test("situations point at procedures that exist, each once, with their file name as id", () => {
  const known = new Set(["napoli/comune/test", "napoli/comune/other"]);
  const ok = tempLibrary({ "apro-test.yaml": JSON.stringify(SITUATION) });
  assert.deepEqual(validateSituations(ok, known, "2026-10-25")[0].errors, []);

  const bad = {
    ...SITUATION,
    id: "altro",
    updated: "2026-10-26",
    steps: [
      { procedure: "napoli/comune/test", when: "Una" },
      { procedure: "napoli/comune/test", when: "Di nuovo" },
      { procedure: "napoli/comune/missing", when: "Nessuna" },
    ],
    intro: "Chiamare RSSMRA85T10A562S",
  };
  const errors = validateSituations(tempLibrary({ "apro-test.yaml": JSON.stringify(bad) }), known, "2026-10-25")[0].errors.join("\n");
  assert.match(errors, /id "altro" must match its file name "apro-test"/);
  assert.match(errors, /updated is in the future/);
  assert.match(errors, /step "napoli\/comune\/test" is listed twice/);
  assert.match(errors, /step "napoli\/comune\/missing" is not a procedure in the library/);
  assert.match(errors, /\/intro: looks like a codice fiscale/);

  const one = { ...SITUATION, steps: [SITUATION.steps[0]] };
  assert.match(validateSituations(tempLibrary({ "apro-test.yaml": JSON.stringify(one) }), known, "2026-10-25")[0].errors.join(), /schema: \/steps must NOT have fewer than 2 items/);
  assert.deepEqual(validateSituations(path.join(tmpdir(), "no-such-dir-xyz"), known, "2026-10-25"), []);
});

test("the real situations validate against the real library", () => {
  const procedures = validateDir(path.join(ROOT, "procedures"), ctx.registry, todayInRome());
  const ids = new Set(procedures.map((r) => (r.doc as { id: string }).id));
  const situations = validateSituations(path.join(ROOT, "situations"), ids, todayInRome());
  assert.ok(situations.length >= 7);
  for (const s of situations) assert.deepEqual(s.errors, [], s.rel);
});

test("a form with the business's data and a person's must say who signs", () => {
  const doc = minimal();
  doc.forms = [
    {
      id: "modulo",
      name: "Modulo",
      fields: [
        { label: "Partita IVA", map: { direct: "business.partita_iva" } },
        { label: "Codice fiscale", map: { direct: "identity.codice_fiscale" } },
      ],
    },
  ];
  assert.match(errorsFor(doc), /uses the business's business\.partita_iva and a person's identity\.codice_fiscale: say who signs/);
  // Any field a person keeps counts, not only identity.
  doc.forms[0].fields[1] = { label: "Recapito", map: { direct: "addresses.home_city" } };
  assert.match(errorsFor(doc), /a person's addresses\.home_city: say who signs/);
  doc.forms[0].fields[1] = { label: "Codice fiscale", map: { direct: "identity.codice_fiscale" } };
  doc.dichiarante = { ruolo: "titolare" };
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);
  // Only for a procedure businesses do: residents sign their own.
  doc.applies_to.audience = ["resident"];
  assert.match(errorsFor(doc), /declares a dichiarante, who signs for a business, but applies_to\.audience has no business/);
  doc.applies_to.audience = ["business"];
  // A person's data alone is the vault owner's, as before.
  delete doc.dichiarante;
  doc.forms[0].fields.shift();
  assert.deepEqual(validateProcedure(doc, PATH, ctx), []);
});
