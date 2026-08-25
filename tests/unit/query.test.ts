import { describe, expect, it } from "vitest";
import { firstMatchOffset, matchReason, parseQuery } from "../../src/search/query.js";
import { normalizeArabic } from "../../src/text/normalize.js";
import { Fiqh4Error } from "../../src/util/errors.js";

describe("parseQuery", () => {
  it("normalises the query with the same rules as the index", () => {
    expect(parseQuery("الصَّلَاةُ", "all_terms").terms).toEqual(["الصلاه"]);
  });

  it("turns phrase/all/any into the same safe token list plus a mode", () => {
    expect(parseQuery("باب الطهارة", "phrase").terms).toEqual(["باب", "الطهاره"]);
    expect(parseQuery("باب الطهارة", "all_terms").mode).toBe("all_terms");
    expect(parseQuery("باب الطهارة", "any_terms").mode).toBe("any_terms");
  });

  it("does not preserve operator syntax from user input", () => {
    const q = parseQuery('باب OR الطهارة NEAR "شيء"', "all_terms");
    expect(q.terms).toEqual(["باب", "OR", "الطهاره", "NEAR", "شيء"]);
  });

  it("drops punctuation rather than letting it break a phrase", () => {
    expect(parseQuery("الوضوء، والغسل.", "phrase").terms).toEqual(["الوضوء", "والغسل"]);
  });

  it("rejects a query with nothing searchable in it", () => {
    for (const bad of ["", "   ", "؟!،.", "«»"]) {
      try {
        parseQuery(bad, "all_terms");
        throw new Error(`should have thrown for ${JSON.stringify(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(Fiqh4Error);
        expect((e as Fiqh4Error).code).toBe("INVALID_QUERY");
      }
    }
  });

  it("keeps the raw query verbatim for echoing back", () => {
    expect(parseQuery("  الصَّلَاةُ  ", "all_terms").raw).toBe("  الصَّلَاةُ  ");
  });

  describe("hash", () => {
    it("is stable for the same query and mode", () => {
      expect(parseQuery("باب الطهارة", "phrase").hash).toBe(parseQuery("باب الطهارة", "phrase").hash);
    });
    it("is equal for queries that normalise the same — they are the same search", () => {
      expect(parseQuery("الصَّلَاةُ", "phrase").hash).toBe(parseQuery("الصلاه", "phrase").hash);
    });
    it("differs when the mode changes", () => {
      expect(parseQuery("باب الطهارة", "phrase").hash).not.toBe(
        parseQuery("باب الطهارة", "all_terms").hash,
      );
    });
    it("differs when the terms change", () => {
      expect(parseQuery("باب الطهارة", "phrase").hash).not.toBe(parseQuery("باب الوضوء", "phrase").hash);
    });
  });
});

describe("matchReason", () => {
  const page = normalizeArabic("باب الطهارة: الوضوء والغسل والتيمم.");

  it("confirms a phrase actually appears in order", () => {
    const r = matchReason(parseQuery("باب الطهارة", "phrase"), page);
    expect(r).toContain("متتابعة");
  });

  it("reports which terms were found and which were not", () => {
    const r = matchReason(parseQuery("الوضوء الاستنجاء", "any_terms"), page);
    expect(r).toContain("الوضوء");
    expect(r).toContain("لم ترد");
  });

  it("counts terms for all_terms mode", () => {
    const r = matchReason(parseQuery("الوضوء والغسل", "all_terms"), page);
    expect(r).toContain("2/2");
  });
});

describe("firstMatchOffset", () => {
  const page = normalizeArabic("مقدمة ثم باب الطهارة ثم خاتمة");

  it("finds the phrase position", () => {
    const at = firstMatchOffset(parseQuery("باب الطهارة", "phrase"), page);
    expect(page.slice(at)).toMatch(/^باب الطهاره/);
  });

  it("returns the earliest matching term for term modes", () => {
    const at = firstMatchOffset(parseQuery("خاتمة الطهارة", "any_terms"), page);
    expect(page.slice(at)).toMatch(/^الطهاره/);
  });

  it("returns -1 when nothing matches", () => {
    expect(firstMatchOffset(parseQuery("الاستحاضة", "any_terms"), page)).toBe(-1);
  });
});
