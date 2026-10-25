// Finds personal data that must never appear in a shared procedure. Candidates
// are confirmed with their check digits, so ordinary words and numbers don't
// trip it, while spaced, dotted, hyphenated or lower-case forms are still caught.

const NOT_ALNUM_BEFORE = "(?<![A-Za-z0-9])";
const NOT_ALNUM_AFTER = "(?![A-Za-z0-9])";
const OMO = "[0-9LMNPQRSTUV]";
// Separators people put inside codes: space, no-break space, tab, dot, hyphen, zero-width space.
const SEP = "[ \\u00a0\\t.\\-\\u200b]";
const SEP_RE = new RegExp(SEP, "g");

// Codice fiscale, optionally printed in groups ("RSS MRA 85T10 A562S", "RSS-MRA-85T10-A562S").
const CF = new RegExp(
  `${NOT_ALNUM_BEFORE}[A-Z]{3}${SEP}?[A-Z]{3}${SEP}?${OMO}{2}[A-EHLMPR-T]${OMO}{2}${SEP}?[A-Z]${OMO}{3}[A-Z]${NOT_ALNUM_AFTER}`,
  "gi",
);

// IBAN lengths for SEPA countries. Only these are checked: a fixed length per
// country keeps the chance of a false match at 1 in 97 per candidate.
const IBAN_LENGTH: Record<string, number> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18, EE: 20,
  ES: 24, FI: 18, FR: 27, GB: 22, GR: 27, HR: 21, HU: 28, IE: 22, IS: 26, IT: 27,
  LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31, NL: 18, NO: 15, PL: 28, PT: 25,
  RO: 24, SE: 24, SI: 19, SK: 24, SM: 27, VA: 22,
};

// An upper-case country code and two check digits, then a run of letters and
// digits with single separators, in any grouping ("IT60 X 05428 11101 …").
// Lower-case country codes are left alone: in prose they are words ("il 15 …").
const IBAN_START = new RegExp(
  `${NOT_ALNUM_BEFORE}([A-Z]{2})${SEP}?(\\d{2})((?:${SEP}?[A-Za-z0-9]){11,40})`,
  "g",
);

const CF_ODD: Record<string, number> = {
  "0": 1, "1": 0, "2": 5, "3": 7, "4": 9, "5": 13, "6": 15, "7": 17, "8": 19, "9": 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};

export function isCodiceFiscale(candidate: string): boolean {
  const cf = candidate.replace(SEP_RE, "").toUpperCase();
  if (cf.length !== 16) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const c = cf[i];
    sum += i % 2 === 0
      ? CF_ODD[c]
      : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (sum % 26)) === cf[15];
}

export function isIBAN(candidate: string): boolean {
  const iban = candidate.replace(SEP_RE, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(iban)) return false;
  const expected = IBAN_LENGTH[iban.slice(0, 2)];
  if (expected ? iban.length !== expected : iban.length < 15 || iban.length > 34) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

// The run after an IBAN's check digits can swallow following words ("… 1332 e
// conserva"), so only the first `length` characters of a known country are tested.
function containsIBAN(country: string, check: string, rest: string): boolean {
  const length = IBAN_LENGTH[country];
  if (!length) return false;
  const body = rest.replace(SEP_RE, "");
  return body.length >= length - 4 && isIBAN(country + check + body.slice(0, length - 4));
}

// Returns a description for each piece of personal data found in text.
export function findPersonalData(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(CF)) if (isCodiceFiscale(m[0])) found.push("codice fiscale");
  for (const m of text.matchAll(IBAN_START)) if (containsIBAN(m[1], m[2], m[3])) found.push("IBAN");
  return found;
}
