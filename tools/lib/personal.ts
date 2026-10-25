// Finds personal data that must never appear in a shared procedure. Candidates
// are confirmed with their check digits, so ordinary words and numbers don't
// trip it, while spaced or lower-case forms are still caught.

const NOT_ALNUM_BEFORE = "(?<![A-Za-z0-9])";
const NOT_ALNUM_AFTER = "(?![A-Za-z0-9])";
const OMO = "[0-9LMNPQRSTUV]";

// Codice fiscale, optionally printed in groups ("RSS MRA 85T10 A562S").
const CF = new RegExp(
  `${NOT_ALNUM_BEFORE}[A-Z]{3} ?[A-Z]{3} ?${OMO}{2}[A-EHLMPR-T]${OMO}{2} ?[A-Z]${OMO}{3}[A-Z]${NOT_ALNUM_AFTER}`,
  "gi",
);

// Any country's IBAN, compact or printed in groups of four.
const IBAN = new RegExp(
  `${NOT_ALNUM_BEFORE}[A-Z]{2}\\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?${NOT_ALNUM_AFTER}`,
  "gi",
);

const CF_ODD: Record<string, number> = {
  "0": 1, "1": 0, "2": 5, "3": 7, "4": 9, "5": 13, "6": 15, "7": 17, "8": 19, "9": 21,
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};

export function isCodiceFiscale(candidate: string): boolean {
  const cf = candidate.replace(/ /g, "").toUpperCase();
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
  const iban = candidate.replace(/ /g, "").toUpperCase();
  if (iban.length < 15 || iban.length > 34) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let rest = 0;
  for (const d of digits) rest = (rest * 10 + Number(d)) % 97;
  return rest === 1;
}

// Returns a description for each piece of personal data found in text.
export function findPersonalData(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(CF)) if (isCodiceFiscale(m[0])) found.push("codice fiscale");
  for (const m of text.matchAll(IBAN)) if (isIBAN(m[0])) found.push("IBAN");
  return found;
}
