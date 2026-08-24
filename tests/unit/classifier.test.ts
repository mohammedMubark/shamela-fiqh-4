import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Classifier, defaultMapPath } from "../../src/classify/classifier.js";
import type { RawBook } from "../../src/shamela/masterRepo.js";
import { Fiqh4Error } from "../../src/util/errors.js";

function book(over: Partial<RawBook> = {}): RawBook {
  return {
    book_id: "1",
    title: "كتاب",
    author: "مؤلف",
    category_id: "1",
    category: null,
    downloaded: true,
    file_path: "/tmp/1.db",
    ...over,
  };
}

function withOverrides(payload: unknown): Classifier {
  const dir = mkdtempSync(join(tmpdir(), "fiqh4-ov-"));
  const path = join(dir, "overrides.json");
  writeFileSync(path, JSON.stringify(payload), "utf8");
  return Classifier.load({ mapPath: defaultMapPath(), overridesPath: path });
}

const plain = () => Classifier.load({ mapPath: defaultMapPath(), overridesPath: join(tmpdir(), "does-not-exist.json") });

describe("classifier precedence", () => {
  it("assigns a madhhab from an exact category name", () => {
    const r = plain().classify(book({ category: "الفقه الشافعي" }));
    expect(r.madhhab).toBe("shafii");
    expect(r.classification_source).toBe("category_map");
  });

  it("matches category names regardless of diacritics or alef form", () => {
    const r = plain().classify(book({ category: "الفقهُ الحنفيُّ" }));
    expect(r.madhhab).toBe("hanafi");
  });

  it("uses the category NAME, never the id — ids are not stable across installs", () => {
    const a = plain().classify(book({ category: "الفقه المالكي", category_id: "3" }));
    const b = plain().classify(book({ category: "الفقه المالكي", category_id: "999" }));
    expect(a.madhhab).toBe("maliki");
    expect(b.madhhab).toBe("maliki");
  });

  it("marks a partial category match as needing review", () => {
    const r = plain().classify(book({ category: "أصول الفقه الحنبلي وقواعده" }));
    expect(r.madhhab).toBe("hanbali");
    expect(r.verification_status).toBe("needs_review");
    expect(r.ambiguity_reasons.some((x) => x.startsWith("partial_category_match:"))).toBe(true);
  });

  it("leaves an unmapped category unclassified", () => {
    const r = plain().classify(book({ category: "اللغة والتراجم" }));
    expect(r.madhhab).toBe("unclassified");
    expect(r.classification_source).toBe("unclassified");
    expect(r.ambiguity_reasons).toContain("category_not_in_map");
  });

  it("records a missing category distinctly from an unmapped one", () => {
    const r = plain().classify(book({ category: null }));
    expect(r.ambiguity_reasons).toContain("no_category_in_catalogue");
  });
});

describe("classifier refuses to guess from titles and authors", () => {
  it("does NOT classify from a title alone", () => {
    const r = plain().classify(book({ title: "المهذب في الفقه الشافعي", category: null }));
    expect(r.madhhab).toBe("unclassified");
    expect(r.ambiguity_reasons).toContain("title_hint_only:shafii");
    expect(r.verification_status).toBe("needs_review");
  });

  it("does NOT classify from an author name alone", () => {
    const r = plain().classify(book({ title: "كتاب", author: "أحمد بن حنبل", category: null }));
    expect(r.madhhab).toBe("unclassified");
    expect(r.ambiguity_reasons).toContain("author_hint_only:hanbali");
  });

  it("keeps the category's verdict when a title hints elsewhere, but flags it", () => {
    const r = plain().classify(book({ title: "النكت على مذهب الشافعي", category: "الفقه الحنفي" }));
    expect(r.madhhab).toBe("hanafi");
    expect(r.classification_source).toBe("category_map");
    expect(r.ambiguity_reasons).toContain("title_hint_conflicts:shafii");
    expect(r.verification_status).toBe("needs_review");
  });

  it("flags conflicting hints when nothing else classifies the book", () => {
    const r = plain().classify(
      book({ title: "الجمع بين الحنفية والشافعية", author: "مالكي", category: null }),
    );
    expect(r.madhhab).toBe("unclassified");
    expect(r.ambiguity_reasons).toContain("conflicting_hints");
  });
});

describe("overrides", () => {
  it("beat the category map and are the only source of 'verified'", () => {
    const cls = withOverrides({
      overrides: [{ book_id: "42", madhhab: "maliki", reason: "راجعها فلان" }],
      include: [],
      exclude: [],
    });
    const r = cls.classify(book({ book_id: "42", category: "الفقه الشافعي" }));
    expect(r.madhhab).toBe("maliki");
    expect(r.classification_source).toBe("override");
    expect(r.verification_status).toBe("verified");
    expect(r.ambiguity_reasons).toEqual([]);
  });

  it("exclude removes a book from every result set", () => {
    const cls = withOverrides({ overrides: [], include: [], exclude: ["7"] });
    expect(cls.isExcluded("7")).toBe(true);
    expect(cls.classifyAll([book({ book_id: "7" }), book({ book_id: "8" })]).map((b) => b.book_id)).toEqual(["8"]);
  });

  it("include marks a book as always in scope", () => {
    const cls = withOverrides({ overrides: [], include: ["9"], exclude: [] });
    expect(cls.isForceIncluded("9")).toBe(true);
  });

  it("rejects a malformed overrides file rather than silently ignoring it", () => {
    expect(() =>
      withOverrides({ overrides: [{ book_id: "1", madhhab: "not-a-madhhab" }], include: [], exclude: [] }),
    ).toThrow(Fiqh4Error);
  });

  it("rejects an override with a non-string book_id", () => {
    expect(() => withOverrides({ overrides: [{ book_id: 5, madhhab: "hanafi" }] })).toThrow(Fiqh4Error);
  });
});

describe("review queue", () => {
  it("lists unmapped categories with their book counts, most common first", () => {
    const cls = plain();
    const classified = cls.classifyAll([
      book({ book_id: "1", category: "اللغة" }),
      book({ book_id: "2", category: "اللغة" }),
      book({ book_id: "3", category: "التراجم" }),
      book({ book_id: "4", category: "الفقه الحنفي" }),
    ]);
    expect(cls.unmappedCategories(classified)).toEqual([
      { category: "اللغة", book_count: 2 },
      { category: "التراجم", book_count: 1 },
    ]);
  });
});
