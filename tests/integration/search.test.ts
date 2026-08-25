import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FIXTURE_MANIFEST } from "../helpers/paths.js";
import { acquireEngine, selectBooks, allBooks, resetContext } from "../../src/context.js";
import { LuceneTextSource } from "../../src/shamela/luceneText.js";
import { runBatchedSearch } from "../../src/pipeline/search.js";
import { parseQuery } from "../../src/search/query.js";
import type { EngineHandle } from "../../src/context.js";
import { Fiqh4Error } from "../../src/util/errors.js";

/**
 * Integration tests over the synthetic corpus.
 *
 * Every assertion is about plumbing — attribution, paging totality, dedup,
 * coverage reporting — checked against the ground truth that make-fixtures.mjs
 * recorded. No test asserts a fiqh position: the corpus is invented prose, and
 * pinning scholarly outcomes from memory is exactly the failure this tool
 * exists to avoid.
 */

const fixtures = JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf8")) as {
  planted_phrases: Record<string, string>;
  books: Array<{
    book_id: string;
    downloaded: boolean;
    pages: number;
    planted: string[];
    planted_pages: Record<string, number[]>;
    has_printed_pages: boolean;
  }>;
};

const ALPHA = fixtures.planted_phrases["alpha"]!;
let handle: EngineHandle;
let text: LuceneTextSource;

beforeAll(async () => {
  resetContext();
  handle = await acquireEngine();
  text = new LuceneTextSource(handle.engine);
}, 120_000);
afterAll(() => handle?.release());

const scope = () => selectBooks({ downloadedOnly: true });

describe("corpus shape", () => {
  it("exercises more than ten books", () => {
    expect(scope().length).toBeGreaterThan(10);
  });

  it("includes books that are catalogued but not downloaded", () => {
    const notDownloaded = allBooks().filter((b) => !b.downloaded);
    expect(notDownloaded.length).toBeGreaterThan(0);
    // They must never appear in a searchable scope: Shamela indexes a book's
    // pages when it downloads them, so an undownloaded book has no text.
    expect(scope().some((b) => notDownloaded.some((n) => n.book_id === b.book_id))).toBe(false);
  });

  it("reads page text from Shamela's Lucene index, not from SQLite", async () => {
    // The book databases carry no text column at all, so any text that comes
    // back has necessarily been read from the index.
    const r = await runBatchedSearch({
      text, query: ALPHA, mode: "phrase", books: scope(), engine: handle.engine,
      limit: 1, includeFullText: true, byteBudget: 500_000,
    });
    expect(r.passages[0]!.text_original.length).toBeGreaterThan(0);
  });
});

describe("search results", () => {
  it("finds the planted phrase and attributes every field", async () => {
    const r = await runBatchedSearch({
      text,
      query: ALPHA,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      limit: 5,
      includeFullText: true,
      byteBudget: 1_000_000,
    });

    expect(r.batch.total_hits).toBeGreaterThan(0);
    const p = r.passages[0]!;
    expect(p.book_id).toBeTruthy();
    expect(p.madhhab).toBeTruthy();
    expect(typeof p.page_id).toBe("number");
    expect(p.toc_path.length).toBeGreaterThan(0);
    expect(p.match_reason).toContain("متتابعة");
    expect(p.text_original.length).toBeGreaterThan(0);
    // The query, the numbering authority and the trust label hold for every
    // passage in the batch, so they are stated once rather than per passage.
    expect(r.notes.query).toBe(ALPHA);
    expect(r.notes.numbering_note_ar).toContain("المكتبة الشاملة");
    expect(r.notes.content_trust).toBe("untrusted_source_text");
  });

  it("matches the ground truth recorded by the fixture generator", async () => {
    const expected = fixtures.books
      .filter((b) => b.downloaded && b.planted.includes("alpha"))
      .reduce((n, b) => n + (b.planted_pages["alpha"]?.length ?? 0), 0);

    const r = await runBatchedSearch({
      text,
      query: ALPHA,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      limit: 1,
      includeFullText: false,
      byteBudget: 1_000_000,
    });
    expect(r.batch.total_hits).toBe(expected);
  });

  it("quotes the original text, not the folded search form", async () => {
    // One in every two planted alphas is written fully diacriticised. Whichever
    // page we land on, the excerpt must reproduce the book's own characters.
    const r = await runBatchedSearch({
      text,
      query: ALPHA,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      limit: 40,
      includeFullText: true,
      byteBudget: 4_000_000,
    });
    const diacriticised = r.passages.filter((p) => /[ً-ْ]/.test(p.excerpt));
    expect(diacriticised.length).toBeGreaterThan(0);
    for (const p of diacriticised) {
      expect(p.text_original).toContain(p.excerpt.replace(/^…\s*|\s*…$/g, "").slice(0, 20));
    }
  });

  it("finds a diacriticised query through normalisation", async () => {
    const bare = await runBatchedSearch({
      text,
      query: ALPHA,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      limit: 1,
      includeFullText: false,
      byteBudget: 100_000,
    });
    const marked = await runBatchedSearch({
      text,
      query: fixtures.planted_phrases["diacritics"]!,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      limit: 1,
      includeFullText: false,
      byteBudget: 100_000,
    });
    expect(marked.batch.total_hits).toBe(bare.batch.total_hits);
  });

  it("returns nothing, without error, for a term absent from the corpus", async () => {
    const r = await runBatchedSearch({
      text,
      query: "كلمةلاتوجدفيالفهرسأبدا",
      mode: "all_terms",
      books: scope(),
      engine: handle.engine,
      limit: 10,
      includeFullText: false,
      byteBudget: 100_000,
    });
    expect(r.batch.total_hits).toBe(0);
    expect(r.batch.has_more).toBe(false);
    expect(r.batch.next_cursor).toBeNull();
    expect(r.batch.truncated).toBe(false);
  });
});

describe("keyset paging is total", () => {
  it("walks every hit exactly once across many batches", async () => {
    const seen = new Set<string>();
    let cursor: string | null = null;
    let batches = 0;
    let total: number | null = null;

    do {
      const r = await runBatchedSearch({
        text,
        query: ALPHA,
        mode: "phrase",
        books: scope(),
        engine: handle.engine,
        limit: 7,
        cursor,
        includeFullText: false,
        byteBudget: 1_000_000,
      });
      total ??= r.batch.total_hits;
      expect(r.batch.total_hits).toBe(total);

      for (const p of r.passages) {
        const key = `${p.book_id}#${p.page_id}`;
        expect(seen.has(key)).toBe(false); // no duplicates across page boundaries
        seen.add(key);
      }
      cursor = r.batch.next_cursor;
      batches++;
    } while (cursor && batches < 500);

    expect(batches).toBeGreaterThan(1);
    expect(seen.size).toBe(total); // no gaps either
  });

  it("announces truncation instead of capping silently", async () => {
    const r = await runBatchedSearch({
      text,
      query: ALPHA,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      limit: 3,
      includeFullText: false,
      byteBudget: 1_000_000,
    });
    expect(r.batch.returned).toBe(3);
    expect(r.batch.total_hits).toBeGreaterThan(3);
    expect(r.batch.truncated).toBe(true);
    expect(r.batch.truncation_reason).toBe("max_results_per_response");
    expect(r.batch.next_cursor).not.toBeNull();
    expect(r.batch.truncation_note_ar.length).toBeGreaterThan(0);
  });

  it("reports a byte-budget truncation and still hands back a usable cursor", async () => {
    const r = await runBatchedSearch({
      text,
      query: ALPHA,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      limit: 50,
      includeFullText: true,
      byteBudget: 3_000, // deliberately tiny
    });
    expect(r.batch.truncation_reason).toBe("byte_budget");
    expect(r.batch.has_more).toBe(true);
    expect(r.batch.next_cursor).not.toBeNull();

    const next = await runBatchedSearch({
      text,
      query: ALPHA,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      limit: 50,
      cursor: r.batch.next_cursor,
      includeFullText: true,
      byteBudget: 3_000,
    });
    const first = new Set(r.passages.map((p) => `${p.book_id}#${p.page_id}`));
    for (const p of next.passages) {
      expect(first.has(`${p.book_id}#${p.page_id}`)).toBe(false);
    }
  });

  it("rejects a cursor issued for a different query", async () => {
    const r = await runBatchedSearch({
      text,
      query: ALPHA,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      limit: 2,
      includeFullText: false,
      byteBudget: 100_000,
    });

    await expect(
      runBatchedSearch({
        text,
        query: fixtures.planted_phrases["beta"]!,
        mode: "phrase",
        books: scope(),
        engine: handle.engine,
        limit: 2,
        cursor: r.batch.next_cursor,
        includeFullText: false,
        byteBudget: 100_000,
      }),
    ).rejects.toThrow(Fiqh4Error);
  });

  it("rejects a cursor when the scope narrows, since the fingerprint changed", async () => {
    const all = scope();
    const r = await runBatchedSearch({
      text,
      query: ALPHA,
      mode: "phrase",
      books: all,
      engine: handle.engine,
      limit: 2,
      includeFullText: false,
      byteBudget: 100_000,
    });

    await expect(
      runBatchedSearch({
        text,
        query: ALPHA,
        mode: "phrase",
        books: all.slice(0, 3),
        engine: handle.engine,
        limit: 2,
        cursor: r.batch.next_cursor,
        includeFullText: false,
        byteBudget: 100_000,
      }),
    ).rejects.toThrow(/CURSOR_STALE/);
  });
});

describe("match modes", () => {
  it("phrase is stricter than all_terms, which is stricter than any_terms", async () => {
    const counts: Record<string, number> = {};
    for (const mode of ["phrase", "all_terms", "any_terms"] as const) {
      const r = await runBatchedSearch({
        text,
        query: ALPHA,
        mode,
        books: scope(),
        engine: handle.engine,
        limit: 1,
        includeFullText: false,
        byteBudget: 100_000,
      });
      counts[mode] = r.batch.total_hits;
    }
    expect(counts["phrase"]!).toBeLessThanOrEqual(counts["all_terms"]!);
    expect(counts["all_terms"]!).toBeLessThanOrEqual(counts["any_terms"]!);
  });
});

describe("engine aggregates", () => {
  it("per-book counts sum to the global total", async () => {
    const q = parseQuery(ALPHA, "phrase");
    const ids = scope().map((b) => b.book_id).sort();
    const counts = await handle.engine.countsByBook(q, ids);
    // Per-book counting never needs a bounded walk, so it never truncates.
    expect(counts.truncated).toBe(false);
    const summed = counts.counts.reduce((n, c) => n + c.hits, 0);

    const r = await runBatchedSearch({
      text,
      query: ALPHA,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      limit: 1,
      includeFullText: false,
      byteBudget: 100_000,
    });
    expect(summed).toBe(r.batch.total_hits);
  });

  it("lists a book's matching pages in page order, matching ground truth", async () => {
    const q = parseQuery(ALPHA, "phrase");
    const book = fixtures.books.find((b) => b.downloaded && b.planted.includes("alpha"))!;
    const pages = await handle.engine.pageIdsForBook(q, book.book_id, 1000);
    expect(pages).toEqual([...pages].sort((a, b) => a - b));
    expect(pages).toEqual(book.planted_pages["alpha"]);
  });
});
