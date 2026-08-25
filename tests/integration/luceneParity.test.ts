import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FIXTURE_MANIFEST } from "../helpers/paths.js";
import { openEngine, resetContext, selectBooks, type EngineHandle } from "../../src/context.js";
import { parseQuery } from "../../src/search/query.js";

const fixtures = JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf8")) as {
  planted_phrases: Record<string, string>;
  books: Array<{
    book_id: string;
    downloaded: boolean;
    planted: string[];
    planted_pages: Record<string, number[]>;
  }>;
};

const ALPHA = fixtures.planted_phrases["alpha"]!;
let handle: EngineHandle;

beforeAll(async () => {
  resetContext();
  handle = await openEngine();
});

afterAll(() => handle?.engine.close());

describe("direct Shamela Lucene engine", () => {
  it("uses the Lucene helper as the active engine", () => {
    expect(handle.id).toBe("lucene");
    expect(handle.engine.id).toBe("lucene");
    expect(handle.engine.indexedBooks().length).toBeGreaterThan(0);
  });

  it("matches the fixture ground truth", async () => {
    const q = parseQuery(ALPHA, "phrase");
    const ids = selectBooks({ downloadedOnly: true }).map((b) => b.book_id).sort();
    const expected = fixtures.books
      .filter((b) => b.downloaded && b.planted.includes("alpha"))
      .reduce((n, b) => n + (b.planted_pages["alpha"]?.length ?? 0), 0);
    const r = await handle.engine.search({ query: q, bookIds: ids, limit: 1, after: null });
    expect(r.totalHits).toBe(expected);
  });

  it("pages through searchAfter without duplicates or gaps", async () => {
    const q = parseQuery(ALPHA, "phrase");
    const ids = selectBooks({ downloadedOnly: true }).map((b) => b.book_id).sort();
    const seen = new Set<string>();
    let after: { score: number; doc: number } | null = null;
    let total: number | null = null;

    for (let guard = 0; guard < 1000; guard++) {
      const r = await handle.engine.search({ query: q, bookIds: ids, limit: 7, after });
      total ??= r.totalHits;
      for (const h of r.hits) {
        const key = `${h.book_id}#${h.page_id}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      if (!r.hasMore || !r.after) break;
      after = r.after;
    }
    expect(seen.size).toBe(total);
  });

  it("fetches original page bodies from Lucene body", async () => {
    const book = fixtures.books.find((b) => b.downloaded && b.planted.includes("alpha"))!;
    const page = book.planted_pages["alpha"]![0]!;
    const rows = await handle.engine.pages(book.book_id, [page]);
    expect(rows[0]?.found).toBe(true);
    expect(rows[0]?.text_original).toMatch(/الزَّاوِيَةِ|الزاوية/);
  });

  it("fetches title text from the title index", async () => {
    const book = fixtures.books.find((b) => b.downloaded)!;
    const rows = await handle.engine.titles(book.book_id, [1]);
    expect(rows[0]?.found).toBe(true);
    expect(rows[0]?.text.length).toBeGreaterThan(0);
  });
});
