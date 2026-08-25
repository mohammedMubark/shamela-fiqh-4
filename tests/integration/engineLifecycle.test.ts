import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireEngine, engineIsOpen, resetContext } from "../../src/context.js";
import { LuceneBridge } from "../../src/search/luceneBridge.js";
import { runBatchedSearch } from "../../src/pipeline/search.js";
import { fetchPassages } from "../../src/pipeline/fetchPassages.js";
import { LuceneTextSource } from "../../src/shamela/luceneText.js";
import { selectBooks, allBooks } from "../../src/context.js";
import { MADHHABS } from "../../src/classify/types.js";

/**
 * Two costs this file exists to keep down, both invisible from the results.
 *
 * The helper is a JVM opening a Lucene index of millions of documents. Building
 * one per tool call — which is what closing it in each tool's `finally` did —
 * meant every call paid that before reading a posting. And resolving a batch of
 * passages one page at a time meant a round trip through the pipe per passage,
 * for text a single query can return.
 *
 * Neither shows up in the output, so neither would be noticed if it came back.
 * These tests fail if it does.
 */

afterEach(() => resetContext());

describe("the helper is shared, not rebuilt per call", () => {
  it("hands the same engine to consecutive acquisitions", async () => {
    const first = await acquireEngine();
    const second = await acquireEngine();
    expect(second.engine).toBe(first.engine);
    first.release();
    second.release();
  }, 120_000);

  it("survives one caller releasing while another still holds it", async () => {
    const first = await acquireEngine();
    const second = await acquireEngine();
    first.release();
    // The second holder must still be able to use it.
    await expect(second.engine.refresh()).resolves.toBeUndefined();
    expect(engineIsOpen()).toBe(true);
    second.release();
  }, 120_000);

  it("re-reads the index generation on every acquisition", async () => {
    // The fingerprint a cursor binds to is built from these statistics. A
    // long-lived helper that never re-read them would keep validating cursors
    // against an index Shamela had since rewritten.
    const handle = await acquireEngine();
    const spy = vi.spyOn(handle.engine, "refresh");
    const again = await acquireEngine();
    expect(spy).toHaveBeenCalled();
    handle.release();
    again.release();
    spy.mockRestore();
  }, 120_000);

  it("resetContext closes it outright", async () => {
    const handle = await acquireEngine();
    expect(engineIsOpen()).toBe(true);
    handle.release();
    resetContext();
    expect(engineIsOpen()).toBe(false);
  }, 120_000);
});

describe("a batch costs a fixed number of round trips", () => {
  it("resolves a search batch's text in one request, whatever its size", async () => {
    const handle = await acquireEngine();
    const text = new LuceneTextSource(handle.engine);
    const books = selectBooks({ madhhabs: [...MADHHABS] }).filter((b) => b.downloaded);

    const sent = vi.spyOn(LuceneBridge.prototype, "send");
    const countOf = (cmd: string): number =>
      sent.mock.calls.filter((c) => c[0] === cmd).length;

    try {
      const small = await runBatchedSearch({
        text: new LuceneTextSource(handle.engine),
        query: "الزاوية",
        mode: "any_terms",
        books,
        engine: handle.engine,
        limit: 3,
        includeFullText: true,
        byteBudget: 4_000_000,
      });
      const smallPageCalls = countOf("getPages");
      sent.mockClear();

      const large = await runBatchedSearch({
        text,
        query: "الزاوية",
        mode: "any_terms",
        books,
        engine: handle.engine,
        limit: 40,
        includeFullText: true,
        byteBudget: 4_000_000,
      });
      const largePageCalls = countOf("getPages");

      // The larger batch really is larger — otherwise the comparison is empty.
      expect(large.passages.length).toBeGreaterThan(small.passages.length);
      expect(small.passages.length).toBeGreaterThan(0);

      // One request each, regardless of how many passages came back. Before the
      // batch was declared up front this was one per passage.
      expect(smallPageCalls).toBe(1);
      expect(largePageCalls).toBe(1);
      expect(largePageCalls).toBeLessThan(large.passages.length);
    } finally {
      sent.mockRestore();
      handle.release();
    }
  }, 120_000);

  it("resolves a fetch window's text in one request too", async () => {
    const handle = await acquireEngine();
    const text = new LuceneTextSource(handle.engine);
    const book = allBooks().find((b) => b.downloaded)!;

    const sent = vi.spyOn(LuceneBridge.prototype, "send");
    try {
      const r = await fetchPassages({
        text,
        query: "الزاوية",
        mode: "any_terms",
        requests: [{ book_id: book.book_id, page_ids: [2, 8, 14, 20, 26] }],
        books: allBooks(),
        neighbors: 1,
        limit: 30,
        byteBudget: 4_000_000,
        includeFullText: true,
      });
      expect(r.passages.length).toBeGreaterThan(3);
      expect(sent.mock.calls.filter((c) => c[0] === "getPages").length).toBe(1);
    } finally {
      sent.mockRestore();
      handle.release();
    }
  }, 120_000);
});
