import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decide, validateRules, type RulesTable } from "./rules.ts";
import type { FileResult } from "./validate.ts";

// A procedure with one verified claim, from source "law".
const PROCEDURES: FileResult[] = [
  { rel: "napoli/comune/shop.yaml", errors: [], doc: { applies_to: { conditions: [{ text: "Un negozio va a SCIA.", status: "verified", source: "law" }] } } },
  { rel: "napoli/comune/sign.yaml", errors: [], doc: { applies_to: { conditions: [{ text: "Un'insegna forse.", status: "unverified", source: "guess" }] } } },
];

function table(): RulesTable {
  return {
    schema_version: 0,
    id: "test",
    title: "Tabella di prova",
    updated: "2026-10-29",
    intro: "Una tabella per i test.",
    facts: {
      evento: { type: "choice", question: "Che cosa succede?", values: { apertura: "Apre", cessazione: "Chiude" } },
      mq: { type: "number", question: "Quanti mq?" },
      insegna: { type: "yes_no", question: "Un'insegna?" },
    },
    rules: [
      {
        id: "apre",
        when: { evento: ["apertura"], mq: { upto: 250 } },
        then: { role: "main", procedure: "napoli/comune/shop", regime: "scia", portal: { settore: "Vicinato", operazione: "Aprire l'attività" } },
        cites: [{ procedure: "napoli/comune/shop", source: "law" }],
        status: "verified",
      },
      { id: "grande", when: { mq: { over: 250 } }, then: { refuse: "Troppo grande." }, status: "verified" },
      { id: "chiude", when: { evento: ["cessazione"], mq: { upto: 250 } }, then: { refuse: "Non ancora." }, status: "verified" },
      {
        id: "insegna",
        when: { evento: ["apertura"], insegna: true },
        then: { role: "also", procedure: "napoli/comune/shop", regime: "scia" },
        cites: [{ procedure: "napoli/comune/shop", source: "law" }],
        status: "unverified",
        note: "Da controllare.",
      },
    ],
  };
}

function validate(t: unknown, name = "test.yaml"): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "rules-"));
  writeFileSync(path.join(dir, name), JSON.stringify(t)); // JSON is valid YAML
  return validateRules(dir, PROCEDURES, "2026-10-29")[0].errors;
}

test("decide asks the facts a rule still waits on, in the table's order, and gives no main meanwhile", () => {
  const d = decide(table(), { evento: "apertura" });
  assert.deepEqual(d.ask, ["mq", "insegna"]);
  assert.equal(d.main, undefined);
  assert.deepEqual(decide(table(), { evento: "cessazione" }).ask, ["mq"]); // the insegna rule fails on evento
});

test("decide gives the main pratica with its portal path once every fact is known", () => {
  const d = decide(table(), { evento: "apertura", mq: 250, insegna: false });
  assert.deepEqual(d, {
    ask: [],
    main: { rule: "apre", procedure: "napoli/comune/shop", regime: "scia", portal: { settore: "Vicinato", operazione: "Aprire l'attività" } },
    also: [],
    refused: [],
    conflict: [],
  });
});

test("decide refuses with a refusing rule's reason, and with an unverified rule's note", () => {
  assert.deepEqual(decide(table(), { evento: "apertura", mq: 251, insegna: false }).refused, [{ rule: "grande", reason: "Troppo grande." }]);
  assert.deepEqual(decide(table(), { evento: "apertura", mq: 10, insegna: true }).refused, [{ rule: "insegna", reason: "Da controllare." }]);
});

test("decide reports main rules that disagree", () => {
  const t = table();
  t.rules.push({ ...t.rules[0], id: "apre-2", then: { role: "main", procedure: "napoli/comune/shop", regime: "autorizzazione" } });
  const d = decide(t, { evento: "apertura", mq: 10, insegna: false });
  assert.deepEqual(d.conflict, ["apre", "apre-2"]);
  assert.equal(d.main, undefined);
});

test("a table that decides every case and cites verified claims validates", () => {
  assert.deepEqual(validate(table()), []);
});

test("the validator finds a case no rule decides, and rules that disagree", () => {
  const gap = table();
  gap.rules = gap.rules.filter((r) => r.id !== "chiude");
  assert.match(validate(gap).join("\n"), /no rule decides evento=cessazione mq=0 insegna=true/);

  const clash = table();
  clash.rules.push({ ...clash.rules[0], id: "apre-2", then: { role: "main", procedure: "napoli/comune/shop", regime: "autorizzazione" } });
  assert.match(validate(clash).join("\n"), /rules apre, apre-2 disagree for evento=apertura mq=0/);
});

test("the validator holds rules to their facts, procedures and verified sources", () => {
  const t = table() as any;
  t.id = "altro";
  t.updated = "2026-10-30";
  t.facts.inutile = { type: "yes_no", question: "Mai usato?" };
  t.facts.mq.values = { a: "A", b: "B" };
  t.rules[0].when.evento = ["riapertura"];
  t.rules[0].when.zona = ["a"];
  t.rules[0].cites = [{ procedure: "napoli/comune/sign", source: "guess" }, { procedure: "napoli/comune/nope", source: "law" }];
  t.rules[3].then.procedure = "napoli/comune/missing";
  t.rules[3].when.insegna = "sì";
  delete t.rules[3].note;
  t.rules.push({ id: "senza-fonti", when: {}, then: { role: "also", procedure: "napoli/comune/shop", regime: "scia" }, status: "verified" });
  const errors = validate(t).join("\n");
  assert.match(errors, /schema: \/rules\/3\/when\/insegna/); // the schema catches a bad condition first
  delete t.rules[3].when.insegna;
  const rest = validate(t).join("\n");
  for (const want of [
    /id "altro" must match its file name "test"/,
    /updated is in the future/,
    /fact inutile is used by no rule/,
    /fact mq: only a choice has values/,
    /rule apre: evento has no value riapertura/,
    /rule apre: no fact zona/,
    /rule apre: no verified claim of napoli\/comune\/sign rests on source guess/,
    /rule apre: cites napoli\/comune\/nope, not a procedure in the library/,
    /rule insegna: napoli\/comune\/missing is not a procedure in the library/,
    /rule insegna: a rule that isn't verified says why in a note/,
    /rule senza-fonti: a rule that names a pratica cites the claims it rests on/,
  ]) assert.match(rest, want);
});

test("the validator refuses personal data in a table", () => {
  const t = table();
  t.intro = "Chiamare RSSMRA85T10A562S";
  assert.match(validate(t).join("\n"), /looks like a codice fiscale; rules must not contain personal data/);
});
