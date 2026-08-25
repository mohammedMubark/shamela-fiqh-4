/**
 * A JavaScript mirror of src/text/normalize.ts, for the fixture generator.
 *
 * The generator is plain .mjs and runs before any build, so it cannot import
 * the TypeScript source. Keeping a mirror here is a duplication, and
 * tests/unit/normalize.test.ts asserts the two agree — if they ever drift, the
 * fixtures would be folded differently from the queries run against them and
 * every search test would fail for a reason no one could see.
 */
const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const ZERO_WIDTH = /[​-‏‪-‮⁠-⁤﻿]/g;
const ARABIC_INDIC = /[٠-٩۰-۹]/g;

const FOLD = {
  "آ": "ا", "أ": "ا", "إ": "ا", "ٱ": "ا",
  "ى": "ي", "ی": "ي", "ؤ": "و", "ة": "ه",
  "گ": "ك", "ک": "ك", "پ": "ب", "چ": "ج",
};
const FOLD_RE = /[آأإٱىیؤةگکپچ]/g;

export function normalizeArabic(input) {
  if (!input) return "";
  return input
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(FOLD_RE, (c) => FOLD[c] ?? c)
    .replace(ARABIC_INDIC, (d) => {
      const cp = d.codePointAt(0);
      return String(cp - (cp >= 0x06f0 ? 0x06f0 : 0x0660));
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Mirrors src/text/html.ts closely enough for fixture bodies. */
export function stripHtml(raw) {
  if (!raw) return "";
  return String(raw)
    .replace(/<\/?(?:p|div|br|tr|li|h[1-6]|blockquote|hr|table|section)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mirrors tokenize() in src/text/normalize.ts, including the ibn rule. */
export function tokenize(normalised) {
  return (normalised.match(/[\p{L}\p{N}]+/gu) ?? []).map((t) => (t === "ابن" ? "بن" : t));
}
