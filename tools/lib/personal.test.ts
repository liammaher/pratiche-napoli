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

test("without check digits, the usual slips still match", () => {
  for (const [text, found] of [
    ["il mio cf è RSSMRA85T1OA562S, scusate", "RSSMRA85T1OA562S"], // O for 0
    ["cf: rssmra85t10a562s", "rssmra85t10a562s"], // lower case
    ["codice RSS MRA 85 T10 A562 S grazie", "RSS MRA 85 T10 A562 S"], // other grouping
    ["cf RSSMR85T10A562S e basta", "RSSMR85T10A562S"], // one letter missing
    ["RSS/MRA/85T10/A562S", "RSS/MRA/85T10/A562S"], // slashes
    ["iban it60x0542811101000000123456 ok", "it60x0542811101000000123456"], // lower case
    ["IBAN IT60 X054 2811 1010 0000 0123 45 per", "IT60 X054 2811 1010 0000 0123 45"], // one digit short
    ["IBAN IT60  X054  2811 1010 0000 0123 456", "IT60  X054  2811 1010 0000 0123 456"], // double spaces
    ["iban it60 x054 2811 1010 0000 0123 456 ok", "it60 x054 2811 1010 0000 0123 456"], // lower case, in groups
    ["cf RSSMRA85T10A562SS fine", "RSSMRA85T10A562SS"], // one character extra
    ["cf RSS\u2009MRA\u202f85T10\u2009A562S", "RSS\u2009MRA\u202f85T10\u2009A562S"], // thin spaces
  ]) {
    const ms = matchPersonalData(text, { checkDigits: false });
    assert.ok(ms.some((m) => text.slice(m.start, m.end) === found), `${text}: ${JSON.stringify(ms.map((m) => text.slice(m.start, m.end)))}`);
  }
});

test("the slips don't catch ordinary text", () => {
  for (const text of [
    "Ho pagato 16 euro di bollo e 66,50 di diritti il 15 ottobre 2026, alle 9:30.",
    "Mod. 1 TARI, protocollo PG/2026/0812345 del 12/10/2026: risposta dopo 23 giorni via PEC.",
    "es. 1250 euro per la SCIA, poi il sopralluogo dei Vigili del Fuoco in via Toledo 156.",
    "napoli/comune/tari-iscrizione-uso-abitativo",
    "Sono andato allo sportello di via Diaz alle 8, ho aspettato circa 45 minuti in coda.",
    // In capitals, as some people type.
    "DI VIA ROMA 25 IL 15",
    "DEL 20 AGOSTO 2009",
    "ISEE 2025 DSU INPS",
    "SUAP 01234567890",
    "BE 12 GENNAIO 2025 O",
    "PROTOCOLLO PG 2026 0812345 DEL 12 10 2026",
    "MOD 1 TARI CONSEGNATO IL 3 MARZO 2026 ORE 10",
  ]) {
    assert.deepEqual(matchPersonalData(text, { checkDigits: false }), [], text);
  }
});

test("without check digits, codes written up against other text are cut out when their check digits hold", () => {
  const loose = (t: string) => matchPersonalData(t, { checkDigits: false }).map((m) => t.slice(m.start, m.end));
  const cf = "RSSMRA80A01F839W";
  assert.deepEqual(loose(`cf${cf}`), [cf]);
  assert.deepEqual(loose(`${cf}grazie`), [cf]);
  assert.deepEqual(loose(`${cf}BNCLRA85T41F839X`), [cf, "BNCLRA85T41F839X"]);
  assert.deepEqual(loose("IBANIT60X0542811101000000123456"), ["IT60X0542811101000000123456"]);
  // Full-width characters, and a soft hyphen inside a code.
  const whole = (t: string) => matchPersonalData(t, { checkDigits: false }).some((m) => m.start === 0 && m.end === t.length);
  assert.ok(whole("\uff32\uff33\uff33\uff2d\uff32\uff21\uff18\uff10\uff21\uff10\uff11\uff26\uff18\uff13\uff19\uff37"));
  assert.ok(whole("RSS\u00adMRA80A01F839W"));
  // Long words, and a glued code whose check digits don't hold, are left alone.
  assert.deepEqual(loose("precipitevolissimevolmente supercalifragilistichespiralidoso"), []);
  assert.deepEqual(loose("cfRSSMRA80A01F839X"), []);
});
