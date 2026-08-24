import { describe, expect, it } from "vitest";
import {
  NORMALIZER_VERSION,
  normalizeArabic,
  normalizeArabicWithMap,
  tokenize,
} from "../../src/text/normalize.js";

describe("Arabic normaliser", () => {
  it("declares a version, since the index fingerprint depends on it", () => {
    expect(NORMALIZER_VERSION).toBe("ar-conservative-1");
  });

  it("is idempotent", () => {
    for (const s of ["الصَّلَاةُ", "كتــاب", "إجماعٌ", "مَسْأَلَة", "١٢٣"]) {
      expect(normalizeArabic(normalizeArabic(s))).toBe(normalizeArabic(s));
    }
  });

  it("leaves an empty or whitespace-only string empty", () => {
    expect(normalizeArabic("")).toBe("");
    expect(normalizeArabic("   \n\t ")).toBe("");
  });

  // ── intended merges: documented, deliberate losses of information ─────────
  describe("intended collisions (documented in SOURCE_POLICY.md)", () => {
    const merges: Array<[string, string, string]> = [
      ["الصَّلَاةُ", "الصلاه", "diacritics are stripped"],
      ["الصلاة", "الصلاه", "teh marbuta folds to heh"],
      ["إجماع", "اجماع", "hamza-below alef folds to bare alef"],
      ["أحمد", "احمد", "hamza-above alef folds to bare alef"],
      ["آدم", "ادم", "alef madda folds to bare alef"],
      ["ٱلكتاب", "الكتاب", "alef wasla folds to bare alef"],
      ["كتــــاب", "كتاب", "tatweel is removed"],
      ["على", "علي", "dotless yeh folds to yeh"],
      ["١٢٣", "123", "Arabic-Indic digits fold to ASCII"],
      ["۴۵", "45", "extended Arabic-Indic digits fold to ASCII"],
    ];
    for (const [a, b, why] of merges) {
      it(`${a} ≡ ${b} — ${why}`, () => {
        expect(normalizeArabic(a)).toBe(normalizeArabic(b));
      });
    }
  });

  // ── the guardrail: over-normalising would wreck citation precision ────────
  describe("must NOT collide", () => {
    const distinct: Array<[string, string, string]> = [
      ["مؤمن", "مومن", "waw-hamza is not folded"],
      ["سائل", "سايل", "yeh-hamza is not folded"],
      ["كتب", "كتاب", "no stemming: distinct forms stay distinct"],
      ["ضرب", "ضارب", "no stemming"],
      ["علم", "عالم", "no stemming"],
      ["حرم", "حرام", "no stemming"],
      ["بيع", "بايع", "no stemming"],
      ["الطهارة", "الطهور", "different words"],
      ["صلاة", "صلة", "different words"],
    ];
    for (const [a, b, why] of distinct) {
      it(`${a} ≠ ${b} — ${why}`, () => {
        expect(normalizeArabic(a)).not.toBe(normalizeArabic(b));
      });
    }
  });

  it("collapses internal whitespace and trims", () => {
    expect(normalizeArabic("  باب   الطهارة \n الوضوء  ")).toBe("باب الطهاره الوضوء");
  });

  it("strips zero-width and bidi controls", () => {
    expect(normalizeArabic("كتاب​الطهارة")).toBe(normalizeArabic("كتابالطهارة"));
    expect(normalizeArabic("‫الصلاة‬")).toBe(normalizeArabic("الصلاة"));
  });

  describe("tokenize", () => {
    it("splits on punctuation so a phrase survives a comma", () => {
      expect(tokenize(normalizeArabic("باب الطهارة: الوضوء، والغسل."))).toEqual([
        "باب",
        "الطهاره",
        "الوضوء",
        "والغسل",
      ]);
    });
    it("returns [] for text with no letters or digits", () => {
      expect(tokenize(normalizeArabic("؟!،.«»"))).toEqual([]);
    });
  });

  // ── the offset map is what keeps quotations faithful ──────────────────────
  describe("normalizeArabicWithMap", () => {
    it("produces exactly the same text as the plain normaliser", () => {
      for (const s of [
        "قال الشافعيُّ: الصَّلَاةُ واجبةٌ عَلَى كلِّ مسلمٍ.",
        "كتــاب  الطهارةِ\nوالوضوء",
        "١٢٣ إجماعٌ آدم ٱلكتاب",
      ]) {
        expect(normalizeArabicWithMap(s).text).toBe(normalizeArabic(s));
      }
    });

    it("maps a normalised match back onto the original, diacritics intact", () => {
      const original = "قال الشافعيُّ: الصَّلَاةُ واجبةٌ عَلَى كلِّ مسلمٍ.";
      const { text, map } = normalizeArabicWithMap(original);
      const at = text.indexOf("الصلاه");
      expect(at).toBeGreaterThanOrEqual(0);
      const start = map[at]!;
      const end = map[at + "الصلاه".length - 1]!;
      // The slice comes from the ORIGINAL string, so it still carries tashkeel.
      expect(original.normalize("NFC").slice(start, end + 1)).toBe("الصَّلَاة");
    });

    it("keeps the map aligned with the output length", () => {
      const { text, map } = normalizeArabicWithMap("الصَّلَاةُ واجبةٌ عَلَى كلِّ مسلمٍ");
      expect(map.length).toBe(text.length);
    });

    it("returns offsets that are non-decreasing and in range", () => {
      const src = "  كتــاب   الطهارةِ\n\nوالوضوءُ ١٢٣ ";
      const { text, map } = normalizeArabicWithMap(src);
      const composed = src.normalize("NFC");
      let prev = -1;
      for (let i = 0; i < text.length; i++) {
        const m = map[i]!;
        expect(m).toBeGreaterThanOrEqual(0);
        expect(m).toBeLessThan(composed.length);
        expect(m).toBeGreaterThan(prev - 1);
        prev = m;
      }
    });

    it("handles an empty string", () => {
      const { text, map } = normalizeArabicWithMap("");
      expect(text).toBe("");
      expect(map.length).toBe(0);
    });
  });
});
