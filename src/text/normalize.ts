/**
 * Conservative Arabic normalisation for the *search* field only.
 *
 * `text_original` is never passed through here — quotations and citations must
 * reproduce what the book actually says. The normalised form exists solely so a
 * user who types without diacritics still finds the passage.
 *
 * The rule set deliberately mirrors Lucene's ArabicNormalizer (minus stemming)
 * so the Node engine and the optional Lucene engine agree on every token. Both
 * engines consume the output of *this* function: the Java bridge indexes an
 * already-normalised string rather than running its own analyzer chain, which
 * is what keeps the two engines from drifting apart.
 *
 * Bump NORMALIZER_VERSION whenever the rules change — the index fingerprint
 * embeds it, so every previously issued cursor is rejected instead of silently
 * returning results from an index built under different rules.
 *
 * Codepoints are written as \u escapes on purpose: these classes are invisible
 * or confusable in an editor, and a reviewer needs to see exactly what is
 * being stripped.
 */
export const NORMALIZER_VERSION = "ar-conservative-1";

/**
 * Combining marks removed:
 *   U+064B..U+065F  tanwin, harakat, sukun, shadda, extended editorial marks
 *   U+0670          superscript alef
 *   U+06D6..U+06ED  Quranic annotation marks
 */
const DIACRITICS = /[ً-ٰٟۖ-ۭ]/g;

/** U+0640 tatweel / kashida — pure typography, never meaningful. */
const TATWEEL = /ـ/g;

/**
 * Zero-width and bidi controls that survive copy/paste out of book readers:
 *   U+200B..U+200F  ZWSP, ZWNJ, ZWJ, LRM, RLM
 *   U+202A..U+202E  bidi embedding/override
 *   U+2060..U+2064  word joiner and invisible operators
 *   U+FEFF          BOM
 */
const ZERO_WIDTH = /[​-‏‪-‮⁠-⁤﻿]/g;

/** U+0660..U+0669 Arabic-Indic, U+06F0..U+06F9 extended Arabic-Indic. */
const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g;

/**
 * Character folds. Each is a deliberate, auditable loss of information:
 *   U+0622 آ, U+0623 أ, U+0625 إ, U+0671 ٱ  → U+0627 ا   (hamza carriers on alef)
 *   U+0649 ى → U+064A ي                      (dotless yeh)
 *   U+0629 ة → U+0647 ه                      (teh marbuta)
 *
 * U+0624 ؤ and U+0626 ئ are intentionally NOT folded: doing so merges distinct
 * words (مؤمن/مومن, سائل/سايل) for very little recall gain.
 */
const FOLD_MAP: Record<string, string> = {
  "آ": "ا",
  "أ": "ا",
  "إ": "ا",
  "ٱ": "ا",
  "ى": "ي",
  "ة": "ه",
};

const FOLD_RE = /[آأإٱىة]/g;

function foldDigit(d: string): string {
  const cp = d.codePointAt(0)!;
  const base = cp >= 0x06f0 ? 0x06f0 : 0x0660;
  return String(cp - base);
}

/**
 * Derive the search form of a string.
 * Pure and idempotent: normalizeArabic(normalizeArabic(x)) === normalizeArabic(x).
 */
export function normalizeArabic(input: string): string {
  if (!input) return "";
  return input
    .normalize("NFC")
    .replace(ZERO_WIDTH, "")
    .replace(DIACRITICS, "")
    .replace(TATWEEL, "")
    .replace(FOLD_RE, (c) => FOLD_MAP[c] ?? c)
    .replace(ARABIC_INDIC_DIGITS, foldDigit)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split normalised text into search tokens. Arabic letters, Latin letters and
 * digits form tokens; everything else is a boundary, so a phrase query is not
 * defeated by an intervening comma.
 */
export function tokenize(normalised: string): string[] {
  return normalised.match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Convenience: raw text straight to tokens. */
export function tokenizeRaw(raw: string): string[] {
  return tokenize(normalizeArabic(raw));
}

/**
 * Normalise while recording, for each character of the output, the index of the
 * character in the input it came from.
 *
 * This is what lets a hit found in `text_search` be highlighted inside
 * `text_original`: we locate the match in normalised space, then map its
 * boundaries back to original offsets. Without the map we would have to excerpt
 * from the normalised text, and the user would be quoted a stripped, folded
 * string rather than what the book actually prints.
 */
export interface NormalisedWithMap {
  text: string;
  /** map[i] = index in the source string of output character i. */
  map: Int32Array;
}

export function normalizeArabicWithMap(input: string): NormalisedWithMap {
  if (!input) return { text: "", map: new Int32Array(0) };

  // NFC can merge characters, which would break a per-character map. Compose
  // first, then treat the composed string as the coordinate system; callers
  // slice `source` with these offsets, so we return the composed source too via
  // the caller normalising its own copy the same way.
  const src = input.normalize("NFC");
  const out: string[] = [];
  const map: number[] = [];

  let pendingSpace = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i] as string;

    if (ZERO_WIDTH_SET.has(ch) || DIACRITIC_SET(ch) || ch === "ـ") continue;

    if (/\s/.test(ch)) {
      // Collapse runs of whitespace, and drop leading whitespace entirely.
      if (out.length > 0) pendingSpace = true;
      continue;
    }

    if (pendingSpace) {
      out.push(" ");
      map.push(i);
      pendingSpace = false;
    }

    const folded = FOLD_MAP[ch];
    if (folded !== undefined) {
      out.push(folded);
      map.push(i);
      continue;
    }

    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x0660 && cp <= 0x0669) || (cp >= 0x06f0 && cp <= 0x06f9)) {
      out.push(foldDigit(ch));
      map.push(i);
      continue;
    }

    out.push(ch);
    map.push(i);
  }

  return { text: out.join(""), map: Int32Array.from(map) };
}

const ZERO_WIDTH_SET = new Set([
  "​", "‌", "‍", "‎", "‏",
  "‪", "‫", "‬", "‭", "‮",
  "⁠", "⁡", "⁢", "⁣", "⁤",
  "﻿",
]);

function DIACRITIC_SET(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  return (
    (cp >= 0x064b && cp <= 0x065f) ||
    cp === 0x0670 ||
    (cp >= 0x06d6 && cp <= 0x06ed)
  );
}
