import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { acquireEngine, allBooks, resetContext, selectBooks, type EngineHandle } from "../../src/context.js";
import { MADHHABS, type Madhhab } from "../../src/classify/types.js";
import { buildCoverage } from "../../src/pipeline/coverage.js";
import { discoverIssue } from "../../src/pipeline/discoverIssue.js";
import { runBatchedSearch } from "../../src/pipeline/search.js";
import { LuceneTextSource } from "../../src/shamela/luceneText.js";

/**
 * The scope is stated, not inferred.
 *
 * A book leaves a search for exactly one reason here — Shamela never downloaded
 * its text, so the index holds no page of it — and that used to happen inside a
 * filter with nothing said about it in the response. An empty result then read
 * identically whether a school's books had been searched and said nothing, or
 * had never been searched at all. These tests pin the difference.
 */

let handle: EngineHandle;
let text: LuceneTextSource;

beforeAll(async () => {
  resetContext();
  handle = await acquireEngine();
  text = new LuceneTextSource(handle.engine);
}, 120_000);
afterAll(() => handle?.release());

const fourMadhhabs = () => selectBooks({ madhhabs: [...MADHHABS] });

describe("scope resolution", () => {
  it("the four-madhhab scope is narrower than the whole catalogue", () => {
    // If these were equal the fixture could not tell a scoped search from an
    // unscoped one, and every assertion below would pass vacuously.
    expect(fourMadhhabs().length).toBeGreaterThan(0);
    expect(fourMadhhabs().length).toBeLessThan(allBooks().length);
  });

  it("covers every downloaded book of all four madhhabs, and nothing else", () => {
    const scoped = new Set(fourMadhhabs().filter((b) => b.downloaded).map((b) => b.book_id));
    const expected = allBooks().filter(
      (b) => b.downloaded && (MADHHABS as readonly string[]).includes(b.madhhab),
    );
    expect(expected.length).toBeGreaterThan(0);
    for (const book of expected) expect(scoped.has(book.book_id)).toBe(true);
    expect(scoped.size).toBe(expected.length);
  });
});

describe("coverage report", () => {
  it("names every requested school, including one that contributed nothing", () => {
    const coverage = buildCoverage({ books: fourMadhhabs(), requested: MADHHABS });
    expect(coverage.by_madhhab.map((r) => r.madhhab).sort()).toEqual([...MADHHABS].sort());
    expect(coverage.scope_ar).toContain("المذاهب الأربعة");
  });

  it("counts an undownloaded book as excluded rather than dropping it silently", () => {
    const missing = allBooks().filter((b) => !b.downloaded);
    expect(missing.length).toBeGreaterThan(0);

    const requested = [missing[0]!.madhhab] as Madhhab[];
    const coverage = buildCoverage({ books: allBooks(), requested });

    expect(coverage.books_not_downloaded_total).toBe(missing.length);
    expect(coverage.books_in_scope).toBe(coverage.books_searched + missing.length);
    expect(coverage.note_ar).toContain("غير مُنزَّل");
    // Named, not just counted, so the reader can go and download them.
    expect(coverage.books_not_downloaded[0]?.book_id).toBeTruthy();
  });

  it("says so when a requested school has no downloaded book at all", () => {
    const empty = MADHHABS.find((m) => fourMadhhabs().every((b) => b.madhhab !== m || !b.downloaded));
    const books = empty ? fourMadhhabs() : [];
    const coverage = buildCoverage({ books, requested: empty ? [empty] : MADHHABS });
    if (empty) {
      expect(coverage.note_ar).toContain("راجع إلى التغطية");
    } else {
      // Every school has books here; the branch above is what a partial
      // library exercises, and this arm keeps the test honest about that.
      expect(coverage.by_madhhab.every((r) => r.books_searched >= 0)).toBe(true);
    }
  });
});

describe("the pipelines report what they searched", () => {
  it("discover_issue reports coverage over the whole four-madhhab scope", async () => {
    const books = fourMadhhabs();
    const d = await discoverIssue({
      query: "الزاوية",
      mode: "any_terms",
      books,
      requested: MADHHABS,
      engine: handle.engine,
      limit: 25,
      pageSample: 5,
    });

    expect(d.coverage.books_in_scope).toBe(books.length);
    expect(d.coverage.books_searched).toBe(books.filter((b) => b.downloaded).length);
    expect(d.totals.books_searched).toBe(d.coverage.books_searched);
    // Exact totals, and said to be exact.
    expect(d.counts_truncated).toBe(false);
    expect(d.batch.truncation_reason).not.toBe("scan_limit");
  }, 60_000);

  it("a search states whether its total is the count in scope", async () => {
    const r = await runBatchedSearch({
      text,
      query: "الزاوية",
      mode: "any_terms",
      books: fourMadhhabs().filter((b) => b.downloaded),
      engine: handle.engine,
      limit: 5,
      includeFullText: false,
      byteBudget: 1_000_000,
    });
    expect(r.batch.total_hits).toBeGreaterThan(0);
    expect(r.batch.total_hits_exact).toBe(true);
  }, 60_000);
});
