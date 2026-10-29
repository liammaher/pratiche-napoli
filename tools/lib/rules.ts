// Rules tables (rules/*.yaml, contract/rules.schema.json): from a few facts
// about a case to the pratiche the law asks for. `decide` is the one reading of
// a table; the validator holds each table to the claims its procedures verify
// and to deciding every combination of its facts exactly once.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { ROOT, parseProcedure, procedureIdFromPath, type FileResult } from "./validate.ts";
import { findPersonalData } from "./personal.ts";

export interface Fact {
  type: "choice" | "yes_no" | "number";
  question: string;
  values?: Record<string, string>;
  how?: string;
  unit?: string;
}
export type Condition = string[] | boolean | { over?: number; upto?: number };
export interface Portal {
  settore: string;
  operazione?: string;
  intervento?: string;
}
export interface Rule {
  id: string;
  when: Record<string, Condition>;
  then: { role: "main" | "also" | "apart"; procedure: string; regime: string; portal?: Portal } | { none: string } | { refuse: string };
  cites?: { procedure: string; source: string }[];
  status: "verified" | "unverified" | "disputed";
  note?: string;
}
export interface RulesTable {
  schema_version: 0;
  id: string;
  title: string;
  updated: string;
  intro: string;
  facts: Record<string, Fact>;
  rules: Rule[];
}
export type FactValue = string | boolean | number;
export interface Outcome {
  rule: string;
  procedure: string;
  regime: string;
  portal?: Portal;
}
export interface Decision {
  ask: string[]; // facts some rule still waits on, in the table's order
  main?: Outcome; // the case's pratica, once no fact is missing
  none?: { rule: string; reason: string }; // no pratica needed, once no fact is missing
  also: Outcome[]; // further pratiche the case adds, filed with the main one; one per procedure
  apart: Outcome[]; // pratiche the case also needs, filed on their own elsewhere
  refused: { rule: string; reason: string }[]; // any one means the case isn't handled
  conflict: string[]; // main (or none) rules that disagree: a broken table
}

// true or false once every fact the condition reads is known, else undefined.
function holds(cond: Condition, value: FactValue | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(cond)) return cond.includes(String(value));
  if (typeof cond === "boolean") return value === cond;
  const n = Number(value);
  return (cond.over === undefined || n > cond.over) && (cond.upto === undefined || n <= cond.upto);
}

// Which pratiche a case needs. A rule fires when every condition holds and
// waits while a fact it reads is unknown; while any waits, its facts are asked
// and no main is given, since a waiting rule might refuse or disagree. A rule
// that isn't verified refuses the case with its note: the table never answers
// from an unchecked claim.
export function decide(table: RulesTable, facts: Record<string, FactValue>): Decision {
  const ask = new Set<string>();
  const fired: Rule[] = [];
  for (const rule of table.rules) {
    let open = false;
    let fails = false;
    for (const [name, cond] of Object.entries(rule.when)) {
      const h = holds(cond, facts[name]);
      if (h === false) fails = true;
      if (h === undefined) open = true;
    }
    if (fails) continue;
    if (open) {
      for (const name of Object.keys(rule.when)) if (facts[name] === undefined) ask.add(name);
      continue;
    }
    fired.push(rule);
  }
  const d: Decision = { ask: Object.keys(table.facts).filter((f) => ask.has(f)), also: [], apart: [], refused: [], conflict: [] };
  const mains: Outcome[] = [];
  const nones: { rule: string; reason: string }[] = [];
  for (const rule of fired) {
    if (rule.status !== "verified") {
      d.refused.push({ rule: rule.id, reason: rule.note! });
    } else if ("refuse" in rule.then) {
      d.refused.push({ rule: rule.id, reason: rule.then.refuse });
    } else if ("none" in rule.then) {
      nones.push({ rule: rule.id, reason: rule.then.none });
    } else {
      const { procedure, regime, portal } = rule.then;
      const o: Outcome = { rule: rule.id, procedure, regime, ...(portal ? { portal } : {}) };
      const list = rule.then.role === "main" ? mains : rule.then.role === "also" ? d.also : d.apart;
      if (list === mains || !list.some((a) => a.procedure === procedure)) list.push(o);
    }
  }
  // A main pratica and "none needed" disagree as two different mains do.
  if (new Set(mains.map((m) => `${m.procedure} ${m.regime}`)).size + (nones.length ? 1 : 0) > 1) {
    d.conflict = [...mains.map((m) => m.rule), ...nones.map((n) => n.rule)];
  } else if (!d.ask.length) {
    if (mains.length) d.main = mains[0];
    else if (nones.length) d.none = nones[0];
  }
  d.also = d.also.filter((a) => a.procedure !== d.main?.procedure);
  return d;
}

const ajv = new Ajv2020.default({ allErrors: true, strict: true });
addFormats.default(ajv);
const checkSchema = ajv.compile(JSON.parse(readFileSync(path.join(ROOT, "contract", "rules.schema.json"), "utf8")));

// The sources a procedure's verified claims rest on: what a rule may cite.
function verifiedSources(doc: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.status === "verified" && typeof o.source === "string") out.add(o.source);
      Object.values(o).forEach(visit);
    }
  };
  visit(doc);
  return out;
}

// Every combination of the facts' values, numbers at each bound the rules use
// and just past it.
function combinations(table: RulesTable): Record<string, FactValue>[] {
  const domain = (name: string, fact: Fact): FactValue[] => {
    if (fact.type === "choice") return Object.keys(fact.values!);
    if (fact.type === "yes_no") return [true, false];
    const bounds = table.rules.flatMap((r) => {
      const c = r.when[name];
      return c && typeof c === "object" && !Array.isArray(c) ? [c.over, c.upto].filter((b): b is number => b !== undefined) : [];
    });
    return [...new Set([0, ...bounds.flatMap((b) => [b, b + 1])])];
  };
  let out: Record<string, FactValue>[] = [{}];
  for (const [name, fact] of Object.entries(table.facts)) {
    out = out.flatMap((c) => domain(name, fact).map((v) => ({ ...c, [name]: v })));
  }
  return out;
}

function conditionProblem(name: string, cond: Condition, fact: Fact): string | null {
  if (fact.type === "choice") {
    if (!Array.isArray(cond)) return `${name} is a choice: give a list of its values`;
    const bad = cond.filter((v) => !(v in fact.values!));
    return bad.length ? `${name} has no value ${bad.join(", ")}` : null;
  }
  if (fact.type === "yes_no") return typeof cond === "boolean" ? null : `${name} is yes_no: give true or false`;
  if (typeof cond !== "object" || Array.isArray(cond)) return `${name} is a number: give over and/or upto`;
  return cond.over !== undefined && cond.upto !== undefined && cond.upto <= cond.over ? `${name}: upto must be above over` : null;
}

const describe = (c: Record<string, FactValue>) => Object.entries(c).map(([k, v]) => `${k}=${v}`).join(" ");

// Validates every table under dir (rules/): the schema, its id as its file
// name, facts and values that exist, procedures in the library, cited sources
// that back a verified claim of that procedure, and every combination of the
// facts decided by one main rule (or "none needed") or refused, never by two
// that disagree.
export function validateRules(dir: string, procedures: FileResult[], today: string): FileResult[] {
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  const docs = new Map(procedures.filter((r) => r.doc).map((r) => [procedureIdFromPath(r.rel), r.doc]));
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/i.test(f))
    .sort()
    .map((file) => {
      const rel = file;
      let doc: unknown;
      try {
        doc = parseProcedure(readFileSync(path.join(dir, file), "utf8"));
      } catch (e) {
        return { rel, errors: [(e as Error).message] };
      }
      if (!checkSchema(doc)) {
        return { rel, errors: (checkSchema.errors ?? []).map((e) => `schema: ${e.instancePath || "/"} ${e.message}`) };
      }
      const t = doc as RulesTable;
      const errors: string[] = [];
      const expected = file.replace(/\.ya?ml$/i, "");
      if (t.id !== expected) errors.push(`id "${t.id}" must match its file name "${expected}"`);
      if (t.updated > today) errors.push("updated is in the future");
      const ids = new Set<string>();
      const used = new Set<string>();
      for (const r of t.rules) {
        if (ids.has(r.id)) errors.push(`rule ${r.id} is listed twice`);
        ids.add(r.id);
        for (const [name, cond] of Object.entries(r.when)) {
          used.add(name);
          const fact = t.facts[name];
          if (!fact) errors.push(`rule ${r.id}: no fact ${name}`);
          else {
            const p = conditionProblem(name, cond, fact);
            if (p) errors.push(`rule ${r.id}: ${p}`);
          }
        }
        if ("procedure" in r.then && !docs.has(r.then.procedure)) errors.push(`rule ${r.id}: ${r.then.procedure} is not a procedure in the library`);
        if (!("refuse" in r.then) && !r.cites?.length) {
          errors.push(`rule ${r.id}: a rule that ${"none" in r.then ? "says no pratica is needed" : "names a pratica"} cites the claims it rests on`);
        }
        for (const c of r.cites ?? []) {
          const p = docs.get(c.procedure);
          if (!p) errors.push(`rule ${r.id}: cites ${c.procedure}, not a procedure in the library`);
          else if (!verifiedSources(p).has(c.source)) errors.push(`rule ${r.id}: no verified claim of ${c.procedure} rests on source ${c.source}`);
        }
      }
      for (const name of Object.keys(t.facts)) if (!used.has(name)) errors.push(`fact ${name} is used by no rule`);
      for (const [name, f] of Object.entries(t.facts)) {
        if ((f.type === "choice") !== !!f.values) errors.push(`fact ${name}: ${f.type === "choice" ? "a choice lists its values" : "only a choice has values"}`);
      }
      for (const r of t.rules) if (r.status !== "verified" && !r.note) errors.push(`rule ${r.id}: a rule that isn't verified says why in a note`);
      if (!errors.length) {
        let undecided = 0;
        let conflicts = 0;
        for (const c of combinations(t)) {
          const d = decide(t, c);
          if (d.conflict.length && conflicts++ < 5) errors.push(`rules ${d.conflict.join(", ")} disagree for ${describe(c)}`);
          if (!d.conflict.length && !d.main && !d.none && !d.refused.length && undecided++ < 5) errors.push(`no rule decides ${describe(c)}`);
        }
        if (conflicts > 5) errors.push(`… ${conflicts - 5} more combinations with rules that disagree`);
        if (undecided > 5) errors.push(`… ${undecided - 5} more combinations no rule decides`);
      }
      const walk = (v: unknown, p: string) => {
        if (typeof v === "string") for (const what of new Set(findPersonalData(v))) errors.push(`${p}: looks like a ${what}; rules must not contain personal data`);
        else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}/${i}`));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${p}/${k}`);
      };
      walk(doc, "");
      return { rel, errors, doc };
    });
}
