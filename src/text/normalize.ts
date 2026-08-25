/**
 * Arabic folding for search.
 *
 * `text_original` is never passed through here — quotations and citations must
 * reproduce what the book actually says. The folded form exists solely so a
 * user who types without diacritics still finds the passage.
 *
 * The rules are not a style choice. Shamela indexed every page with its own
 * analyzer, and this extension queries **that** index, so a query term folded
 * any differently simply cannot match a term Shamela stored. The rules below
 * mirror Shamela's folding exactly, verified against a real installation and
 * against the reference implementation in shamela-tafseer-mcp
 * (`src/java/.../Normalize.java`).
 *
 * That is why `ؤ → و` is folded here even though a general-purpose Arabic
 * normaliser would leave it alone: Shamela folds it, so we must too.
 *
 * Bump NORMALIZER_VERSION whenever the rules change — the index fingerprint
 * embeds it, so every previously issued cursor is rejected instead of silently
 * returning results produced under different rules.
 *
 * Codepoints are written as \u escapes on purpose: these classes are invisible
 * or confusable in an editor, and a reviewer needs to see exactly what is
 * being stripped.
 */
export const NORMALIZER_VERSION = "shamela-compat-1";

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
 * Character folds, matching Shamela's analyzer:
 *   U+0622 آ, U+0623 أ, U+0625 إ, U+0671 ٱ  → U+0627 ا   hamza carriers on alef
 *   U+0649 ى → U+064A ي                      dotless yeh
 *   U+06CC ی → U+064A ي                      Farsi yeh
 *   U+0624 ؤ → U+0648 و                      waw with hamza
 *   U+0629 ة → U+0647 ه                      teh marbuta
 *   U+06AF گ → U+0643 ك, U+06A9 ک → U+0643 ك gaf / keheh
 *   U+067E پ → U+0628 ب, U+0686 چ → U+062C ج pe / che
 *
 * U+0626 ئ is NOT folded — Shamela leaves it alone, and so do we.
 */
const FOLD_MAP: Record<string, string> = {
  "آ": "ا",
  "أ": "ا",
  "إ": "ا",
  "ٱ": "ا",
  "ى": "ي",
  "ی": "ي",
  "ؤ": "و",
  "ة": "ه",
  "گ": "ك",
  "ک": "ك",
  "پ": "ب",
  "چ": "ج",
};

const FOLD_RE = /[آأإٱىیؤةگکپچ]/g;

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
 * Shamela's analyzer stores the token «ابن» as «بن». After the alef fold above,
 * every spelling of it has already collapsed to one form, so a single equality
 * check covers them all. Applied per token, never to a substring.
 */
export function foldToken(token: string): string {
  return token === "ابن" ? "بن" : token;
}

/**
 * Split normalised text into search tokens. Arabic letters, Latin letters and
 * digits form tokens; everything else is a boundary, so a phrase query is not
 * defeated by an intervening comma.
 */
export function tokenize(normalised: string): string[] {
  return (normalised.match(/[\p{L}\p{N}]+/gu) ?? []).map(foldToken);
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
