import { test } from "node:test";
import assert from "node:assert/strict";
import { findPersonalData, isIBAN, matchPersonalData } from "./personal.ts";

test("IBANs are found in the formats people actually print", () => {
  for (const text of [
    "IT60X0542811101000000123456",
    "IT60 X054 2811 1010 0000 0123 456",
    "IT60 X 05428 11101 000000123456", // usual Italian bank layout
    "IT 60 X 05428 11101 000000123456",
    "IT60 X054 2811 1010 0000 0123 456",
    "IT60-X054-2811-1010-0000-0123-456",
    "conto DE89370400440532013000",
    "GB29NWBK60161331926819",
  ]) {
    assert.deepEqual(findPersonalData(text), ["IBAN"], text);
  }
});

test("an IBAN followed by a short word is still found", () => {
  for (const text of [
    "Paga su ES91 2100 0418 4502 0005 1332 e conserva",
    "IBAN BE68539007547034 per il rimborso",
    "AT61 1904 3002 3457 3201 di",
  ]) {
    assert.deepEqual(findPersonalData(text), ["IBAN"], text);
  }
});

test("codici fiscali are found however they are separated", () => {
  for (const text of [
    "RSSMRA85T10A562S",
    "rssmra85t10a562s",
    "cf_RSSMRA85T10A562S",
    "RSS MRA 85T10 A562S",
    "RSS-MRA-85T10-A562S",
    "RSS.MRA.85T10.A562S",
    "RSS\tMRA\t85T10\tA562S",
  ]) {
    assert.deepEqual(findPersonalData(text), ["codice fiscale"], text);
  }
});

test("ordinary text, codes and wrong check digits are not flagged", () => {
  for (const text of [
    "IT60X0542811101000000123457", // wrong check digits
    "RSSMRA85T10A562X",
    "entro il 15 marzo 2026 presso lo sportello",
    "al 30 giugno di ogni anno, se dovuto", // lower-case words, not country codes
    "PD20180010973",
    "Codice ente F839 e codici tributo 3944 TEFA rateazione 0101",
    "Telefono 081 795 3711",
    "sovrastrutturale e precipitosamente",
  ]) {
    assert.deepEqual(findPersonalData(text), [], text);
  }
});

test("an IBAN must have its country's exact length", () => {
  assert.equal(isIBAN("IT60X0542811101000000123456"), true);
  assert.equal(isIBAN("IT60X054281110100000012345"), false); // one short
  assert.equal(isIBAN("BE68539007547034"), true);
});

test("matches cover the personal data and nothing after it", () => {
  for (const [text, found] of [
    ["cf RSS MRA 85T10 A562S grazie", "RSS MRA 85T10 A562S"],
    ["Paga su ES91 2100 0418 4502 0005 1332 e conserva", "ES91 2100 0418 4502 0005 1332"],
    ["IBAN BE68539007547034 per il rimborso", "BE68539007547034"],
  ]) {
    const [m] = matchPersonalData(text);
    assert.equal(text.slice(m.start, m.end), found, text);
  }
});

test("without check digits, mistyped codes still match", () => {
  for (const [text, found] of [
    ["cf RSSMRA85T10A562X grazie", "RSSMRA85T10A562X"], // wrong check letter
    ["IBAN IT61 X054 2811 1010 0000 0123 456 per", "IT61 X054 2811 1010 0000 0123 456"], // wrong check digits
  ]) {
    assert.deepEqual(findPersonalData(text), [], text);
    const [m] = matchPersonalData(text, { checkDigits: false });
    assert.equal(text.slice(m.start, m.end), found, text);
  }
});
