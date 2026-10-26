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
function containsIBAN(country: string, check: string, rest: string, checkDigits = true): boolean {
  const length = IBAN_LENGTH[country];
  if (!length) return false;
  const body = rest.replace(SEP_RE, "").slice(0, length - 4);
  if (body.length < length - 4) return false;
  // Without check digits to confirm it, mostly digits, as looksLikeIBAN.
  return checkDigits ? isIBAN(country + check + body) : (body.match(/\d/g) ?? []).length >= body.length * 0.75;
}

export interface PersonalDataMatch {
  kind: "codice fiscale" | "IBAN";
  start: number;
  end: number; // exclusive
}

// Where each piece of personal data sits in text, so it can be cut out. An
// IBAN's match ends after its country's length, not after the words it swallowed.
// With checkDigits false, a code with the right shape counts even if its check
// digits are wrong, as when someone mistypes their own, and so do the usual
// slips (see looseMatches): right for cutting data out of private text, too
// eager for flagging a shared procedure.
export function matchPersonalData(text: string, { checkDigits = true } = {}): PersonalDataMatch[] {
  const found: PersonalDataMatch[] = checkDigits ? [] : looseMatches(text);
  for (const m of text.matchAll(CF)) {
    if (!checkDigits || isCodiceFiscale(m[0])) found.push({ kind: "codice fiscale", start: m.index, end: m.index + m[0].length });
  }
  for (const m of text.matchAll(IBAN_START)) {
    if (!containsIBAN(m[1], m[2], m[3], checkDigits)) continue;
    let left = IBAN_LENGTH[m[1]];
    let end = m.index;
    while (left > 0) if (/[A-Za-z0-9]/.test(text[end++])) left--;
    found.push({ kind: "IBAN", start: m.index, end });
  }
  return found;
}

// Returns a description for each piece of personal data found in text.
export function findPersonalData(text: string): string[] {
  return matchPersonalData(text).map((m) => m.kind);
}

// --- Mistyped codes, for cutting them out of private text ---

// What people type in a code by mistake: 0 for O, 1 for I or L, 5 for S...
const AS_LETTER: Record<string, string> = { "0": "O", "1": "I", "2": "Z", "5": "S", "6": "G", "8": "B" };
const AS_DIGIT: Record<string, string> = { O: "0", I: "1", L: "1", Z: "2", S: "5", G: "6", B: "8" };
// Any of these, one or two at a time, may sit between the characters of a code.
const LOOSE_SEP = /^[ \u00a0\u2009\u202f\t.\-_/\u200b]{1,2}$/;
// A codice fiscale's shape: L letter, D digit (or omocodia letter), M month letter.
const CF_SHAPE = "LLLLLLDDMDDLDDDL";

// Letters or digits read from `start`, skipping separators, up to `count`;
// where each one is in the text, or undefined if the run is shorter.
function run(text: string, start: number, count: number): number[] | undefined {
  const at: number[] = [];
  let i = start;
  while (at.length < count && i < text.length) {
    if (/[A-Za-z0-9]/.test(text[i])) {
      at.push(i++);
      continue;
    }
    let j = i;
    while (j < text.length && !/[A-Za-z0-9]/.test(text[j])) j++;
    if (!at.length || j >= text.length || !LOOSE_SEP.test(text.slice(i, j))) return undefined;
    i = j;
  }
  return at.length === count ? at : undefined;
}

// How many characters of `chars` had to be read as something else to fit
// `shape` (a digit for a letter, a letter for a digit), or Infinity if some
// can't fit at all. Omocodia letters count too: rare, and in prose common.
function swaps(chars: string, shape: string): number {
  let n = 0;
  for (const [i, c] of [...chars].entries()) {
    const kind = shape[i];
    const letter = /[A-Z]/.test(c);
    if (kind === "D") {
      if (/\d/.test(c)) continue;
      if (!/[LMNPQRSTUV]/.test(c) && !AS_DIGIT[c]) return Infinity;
      n++;
    } else {
      const as = letter ? c : AS_LETTER[c];
      if (!as || (kind === "M" && !/[A-EHLMPR-T]/.test(as))) return Infinity;
      if (!letter) n++;
    }
  }
  return n;
}

// The shapes a codice fiscale typed with one character missing or extra
// could have: the full one, without any one position, or with one more
// character anywhere (tried by leaving each of the typed ones out).
function fitsSomehow(chars: string, fit: (chars: string, shape: string) => boolean): boolean {
  if (chars.length === 16) return fit(chars, CF_SHAPE);
  if (chars.length === 15) return [...CF_SHAPE].some((_, k) => fit(chars, CF_SHAPE.slice(0, k) + CF_SHAPE.slice(k + 1)));
  if (chars.length === 17) return [...chars].some((_, k) => fit(chars.slice(0, k) + chars.slice(k + 1), CF_SHAPE));
  return false;
}

// A codice fiscale typed with a slip: any case, at most two letters and
// digits swapped as above, separators anywhere, one character missing or
// extra. Ordinary words, even in capitals, need many more swaps to fit.
function looksLikeCodiceFiscale(chars: string): boolean {
  return fitsSomehow(chars, (c, shape) => swaps(c, shape) <= 2);
}

// An IBAN typed with a slip: any case, separators anywhere, one character
// more or less than its country's length. Two check digits, then mostly
// digits (even a British IBAN's four letters leave three quarters), which
// prose never is.
function looksLikeIBAN(chars: string): boolean {
  const length = IBAN_LENGTH[chars.slice(0, 2)];
  if (!length || Math.abs(chars.length - length) > 1 || !/^\d{2}$/.test(chars.slice(2, 4))) return false;
  const body = chars.slice(4);
  return (body.match(/\d/g) ?? []).length >= body.length * 0.75;
}

// Codes typed with a slip, from each word's start: the longest run that looks
// like one, so "RSS MRA 85 T10 A562 S" goes as a whole.
function looseMatches(text: string): PersonalDataMatch[] {
  const found: PersonalDataMatch[] = [];
  let i = 0;
  while (i < text.length) {
    if (!/[A-Za-z0-9]/.test(text[i]) || (i > 0 && /[A-Za-z0-9]/.test(text[i - 1]))) {
      i++;
      continue;
    }
    const match = attempt(text, i);
    if (match) {
      found.push(match);
      i = match.end;
    } else i++;
  }
  return found;
}

function attempt(text: string, start: number): PersonalDataMatch | undefined {
  const tries: [PersonalDataMatch["kind"], number, (chars: string) => boolean][] = [];
  const country = IBAN_LENGTH[text.slice(start, start + 2).toUpperCase()];
  if (country) for (const n of [country + 1, country, country - 1]) tries.push(["IBAN", n, looksLikeIBAN]);
  for (const n of [17, 16, 15]) tries.push(["codice fiscale", n, looksLikeCodiceFiscale]);
  for (const [kind, count, looks] of tries) {
    const at = run(text, start, count);
    if (!at) continue;
    const end = at[at.length - 1] + 1;
    // The code must end where a word does, and a codice fiscale written in
    // pieces is in capitals (as printed on the card), unlike the words of a
    // sentence; an IBAN's digits tell it from prose in any case.
    if (end < text.length && /[A-Za-z0-9]/.test(text[end])) continue;
    if (kind === "codice fiscale" && end - start > count && /[a-z]/.test(text.slice(start, end))) continue;
    if (looks(at.map((j) => text[j].toUpperCase()).join(""))) return { kind, start, end };
  }
  return undefined;
}
