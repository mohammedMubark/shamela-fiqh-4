import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FIXTURE_MANIFEST } from "../helpers/paths.js";
import { allBooks, openEngine, resetContext, type EngineHandle } from "../../src/context.js";
import { LuceneTextSource } from "../../src/shamela/luceneText.js";
import { fetchPassages } from "../../src/pipeline/fetchPassages.js";
import { BookReader } from "../../src/shamela/bookRepo.js";

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
const withAlpha = fixtures.books.find((b) => b.downloaded && b.planted.includes("alpha"))!;
const noPrintedPages = fixtures.books.find((b) => b.downloaded && !b.has_printed_pages)!;

let handle: EngineHandle;
let text: LuceneTextSource;

beforeAll(async () => {
  resetContext();
  handle = await openEngine();
  text = new LuceneTextSource(handle.engine);
}, 120_000);
afterAll(() => handle?.engine.close());

describe("fetch_passages", () => {
  it("returns the requested pages with full original text", async () => {
    const pages = withAlpha.planted_pages["alpha"]!.slice(0, 3);
    const r = await fetchPassages({
      text,
      query: ALPHA,
      mode: "phrase",
      requests: [{ book_id: withAlpha.book_id, page_ids: pages }],
      books: allBooks(),
      neighbors: 0,
      limit: 50,
      byteBudget: 2_000_000,
      includeFullText: true,
    });
    expect(r.passages.length).toBe(pages.length);
    for (const p of r.passages) {
      expect(p.text_original.length).toBeGreaterThan(0);
      expect(p.content_trust).toBe("untrusted_source_text");
      expect(p.match_reason).toContain("متتابعة");
    }
  });

  it("adds neighbouring pages and labels them as context, not matches", async () => {
    const page = withAlpha.planted_pages["alpha"]![2]!;
    const r = await fetchPassages({
      text,
      query: ALPHA,
      mode: "phrase",
      requests: [{ book_id: withAlpha.book_id, page_ids: [page] }],
      books: allBooks(),
      neighbors: 2,
      limit: 50,
      byteBudget: 2_000_000,
      includeFullText: false,
    });
    expect(r.passages.map((p) => p.page_id)).toEqual([page - 2, page - 1, page, page + 1, page + 2]);
    const context = r.passages.filter((p) => p.page_id !== page);
    for (const c of context) expect(c.match_reason).toContain("مجاورة");
  });

  it("de-duplicates overlapping neighbour windows", async () => {
    // Two adjacent pages with a radius of 2 overlap heavily; each page must
    // appear exactly once.
    const r = await fetchPassages({
      text,
      query: ALPHA,
      mode: "phrase",
      requests: [{ book_id: withAlpha.book_id, page_ids: [40, 41, 42] }],
      books: allBooks(),
      neighbors: 2,
      limit: 100,
      byteBudget: 2_000_000,
      includeFullText: false,
    });
    const ids = r.passages.map((p) => p.page_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("pages through a large request without repeating a passage", async () => {
    const pages = withAlpha.planted_pages["alpha"]!;
    const requests = [{ book_id: withAlpha.book_id, page_ids: pages }];
    const seen = new Set<number>();
    let cursor: string | null = null;
    let rounds = 0;

    do {
      const r = await fetchPassages({
      text,
        query: ALPHA,
        mode: "phrase",
        requests,
        books: allBooks(),
        neighbors: 1,
        limit: 3,
        byteBudget: 2_000_000,
        cursor,
        includeFullText: false,
      });
      for (const p of r.passages) {
        expect(seen.has(p.page_id)).toBe(false);
        seen.add(p.page_id);
      }
      cursor = r.batch.next_cursor;
      rounds++;
    } while (cursor && rounds < 200);

    expect(rounds).toBeGreaterThan(1);
    expect(seen.size).toBeGreaterThan(pages.length);
  });

  it("reports an undownloaded book as a failure rather than silently dropping it", async () => {
    const missing = fixtures.books.find((b) => !b.downloaded)!;
    const r = await fetchPassages({
      text,
      query: ALPHA,
      mode: "phrase",
      requests: [{ book_id: missing.book_id, page_ids: [1, 2] }],
      books: allBooks(),
      neighbors: 0,
      limit: 10,
      byteBudget: 500_000,
      includeFullText: false,
    });
    expect(r.passages.length).toBe(0);
    expect(r.failed_books).toHaveLength(1);
    expect(r.failed_books[0]!.book_id).toBe(missing.book_id);
    expect(r.failed_books[0]!.reason).toContain("غير مُنزَّل");
  });

  it("reports an unknown book id explicitly", async () => {
    const r = await fetchPassages({
      text,
      query: ALPHA,
      mode: "phrase",
      requests: [{ book_id: "no-such-book", page_ids: [1] }],
      books: allBooks(),
      neighbors: 0,
      limit: 10,
      byteBudget: 500_000,
      includeFullText: false,
    });
    expect(r.failed_books[0]!.book_id).toBe("no-such-book");
  });

  it("reports a requested page that does not exist, but not a missing neighbour", async () => {
    const beyondEnd = withAlpha.pages + 50;
    const r = await fetchPassages({
      text,
      query: ALPHA,
      mode: "phrase",
      requests: [{ book_id: withAlpha.book_id, page_ids: [beyondEnd] }],
      books: allBooks(),
      neighbors: 2,
      limit: 10,
      byteBudget: 500_000,
      includeFullText: false,
    });
    expect(r.missing_pages).toEqual([{ book_id: withAlpha.book_id, page_id: beyondEnd }]);
  });
});

describe("citation fidelity", () => {
  it("reports a real printed page when Shamela records one", () => {
    const book = allBooks().find((b) => b.book_id === withAlpha.book_id)!;
    const reader = BookReader.open(book.file_path!);
    try {
      const page = reader.pageById(10)!;
      // Pagination still comes from SQLite; only the words moved to Lucene.
      expect(page.printed_page).toBe(10);
      expect(page.part).not.toBeNull();
    } finally {
      reader.close();
    }
  });

  it("returns null — never a guess — when Shamela records no printed page", () => {
    const book = allBooks().find((b) => b.book_id === noPrintedPages.book_id)!;
    const reader = BookReader.open(book.file_path!);
    try {
      const page = reader.pageById(10)!;
      expect(page.printed_page).toBeNull();
      // The internal page id must not leak into the printed-page slot.
      expect(page.page_id).toBe(10);
    } finally {
      reader.close();
    }
  });

  it("builds a heading trail from the book's own table of contents", () => {
    const book = allBooks().find((b) => b.book_id === withAlpha.book_id)!;
    const reader = BookReader.open(book.file_path!);
    try {
      const path = reader.tocPath(60);
      expect(path.length).toBeGreaterThan(0);
      for (const t of path) expect(typeof t).toBe("string");
    } finally {
      reader.close();
    }
  });
});
