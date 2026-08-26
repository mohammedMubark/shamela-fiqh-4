import { describe, expect, it } from "vitest";
import { LuceneTextSource } from "../../src/shamela/luceneText.js";
import type { ShamelaSearchEngine } from "../../src/search/shamelaEngine.js";

/**
 * The caches inside LuceneTextSource must stay bounded.
 *
 * A single "operation" can be a full export sweeping the whole library, and an
 * unbounded page cache turned that into "hold every page body ever read" —
 * measured at +33.7 MB of heap still retained after a 70,035-hit export on the
 * 77,000-page fixture, against -0.1 MB once bounded. The bound is what keeps
 * `all_results` at near-constant memory.
 */

/** Records what it was asked for, so memoisation can be observed. */
function fakeEngine() {
  const pageCalls: number[][] = [];
  const titleCalls: number[][] = [];
  const engine = {
    async getPages(_bookId: string, ids: number[]) {
      pageCalls.push([...ids]);
      return ids.map((id) => ({ found: true, page_id: id, body: `body-${id}`, foot: null }));
    },
    async getTitles(_bookId: string, ids: number[]) {
      titleCalls.push([...ids]);
      return ids.map((id) => ({ found: true, title_id: id, body: `title-${id}` }));
    },
  };
  return { engine: engine as unknown as ShamelaSearchEngine, pageCalls, titleCalls };
}

const range = (from: number, count: number) =>
  Array.from({ length: count }, (_unused, i) => from + i);

describe("LuceneTextSource caching", () => {
  it("caps the page cache however many pages an operation reads", async () => {
    const { engine } = fakeEngine();
    const text = new LuceneTextSource(engine);

    for (let batch = 0; batch < 6; batch++) {
      await text.pageText("b1", range(batch * 500, 500));
    }

    expect(text.cacheSize.pages).toBe(1024);
  });

  it("still returns every page asked for, cached or not", async () => {
    const { engine } = fakeEngine();
    const text = new LuceneTextSource(engine);

    await text.pageText("b1", range(0, 2000));
    const got = await text.pageText("b1", range(0, 2000));

    expect(got.size).toBe(2000);
    expect(got.get(0)?.body).toBe("body-0");
    expect(got.get(1999)?.body).toBe("body-1999");
  });

  it("serves a recent page from memory instead of re-asking the index", async () => {
    const { engine, pageCalls } = fakeEngine();
    const text = new LuceneTextSource(engine);

    await text.pageText("b1", [10, 11, 12]);
    await text.pageText("b1", [11, 12, 13]);

    expect(pageCalls).toEqual([[10, 11, 12], [13]]);
  });

  it("keys the cache by book, so two books never share a page id", async () => {
    const { engine, pageCalls } = fakeEngine();
    const text = new LuceneTextSource(engine);

    await text.pageText("b1", [7]);
    await text.pageText("b2", [7]);

    expect(pageCalls).toEqual([[7], [7]]);
  });

  it("caps the heading cache too", async () => {
    const { engine } = fakeEngine();
    const text = new LuceneTextSource(engine);

    await text.titleText("b1", range(0, 5000));

    expect(text.cacheSize.titles).toBe(4096);
  });
});
