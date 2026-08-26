import { describe, expect, it } from "vitest";
import { LuceneTextSource } from "../../src/shamela/luceneText.js";
import type { ShamelaSearchEngine } from "../../src/search/shamelaEngine.js";

/**
 * The caches inside LuceneTextSource must stay bounded — and must never evict
 * text the current caller is about to read.
 *
 * A single "operation" can be a full export sweeping the whole library, and an
 * unbounded page cache turned that into "hold every page body ever read":
 * +33.7 MB of heap still retained after a 70,035-hit export on the 77,000-page
 * fixture, against -0.1 MB once bounded. But a bound that evicts the batch that
 * `warm()` just fetched would blank passages instead, which is worse — so the
 * ceiling stretches to fit whatever a single request asked for.
 */

/** Records what it was asked for, so batching and memoisation can be observed. */
function fakeEngine(missing: (bookId: string, id: number) => boolean = () => false) {
  const pageCalls: Array<Map<string, number[]>> = [];
  const titleCalls: Array<Map<string, number[]>> = [];
  const engine = {
    async getPagesBatched(byBook: Map<string, number[]>) {
      pageCalls.push(new Map([...byBook].map(([b, ids]) => [b, [...ids]])));
      return new Map(
        [...byBook].map(([bookId, ids]) => [
          bookId,
          ids.map((id) => ({
            found: !missing(bookId, id),
            page_id: id,
            body: missing(bookId, id) ? null : `body-${bookId}-${id}`,
            foot: null,
          })),
        ]),
      );
    },
    async getTitlesBatched(byBook: Map<string, number[]>) {
      titleCalls.push(new Map([...byBook].map(([b, ids]) => [b, [...ids]])));
      return new Map(
        [...byBook].map(([bookId, ids]) => [
          bookId,
          ids.map((id) => ({ found: true, title_id: id, body: `title-${bookId}-${id}` })),
        ]),
      );
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

  it("keeps a whole batch even when the batch is larger than the cap", async () => {
    const { engine } = fakeEngine();
    const text = new LuceneTextSource(engine);

    const got = await text.pageText("b1", range(0, 3000));

    // Every page asked for comes back — the trim must not eat its own batch.
    expect(got.size).toBe(3000);
    expect(got.get(0)?.body).toBe("body-b1-0");
    expect(got.get(2999)?.body).toBe("body-b1-2999");
    expect(text.cacheSize.pages).toBe(3000);
  });

  it("shrinks back to the cap once the oversized batch is behind it", async () => {
    const { engine } = fakeEngine();
    const text = new LuceneTextSource(engine);

    await text.pageText("b1", range(0, 3000));
    await text.pageText("b1", range(10_000, 10));

    expect(text.cacheSize.pages).toBe(1024);
  });

  it("keeps pages the caller re-asks for, evicting the untouched ones instead", async () => {
    const { engine, pageCalls } = fakeEngine();
    const text = new LuceneTextSource(engine);

    await text.pageText("b1", range(0, 1000)); // fills most of the cap
    await text.pageText("b1", [0, 1, 2]); // touched: now the newest
    await text.pageText("b1", range(5000, 500)); // pushes the cache over the cap
    pageCalls.length = 0;

    const got = await text.pageText("b1", [0, 1, 2]);

    expect(got.size).toBe(3);
    expect(pageCalls).toEqual([]); // still cached: never re-fetched
  });

  it("serves a recent page from memory instead of re-asking the index", async () => {
    const { engine, pageCalls } = fakeEngine();
    const text = new LuceneTextSource(engine);

    await text.pageText("b1", [10, 11, 12]);
    await text.pageText("b1", [11, 12, 13]);

    expect(pageCalls).toEqual([new Map([["b1", [10, 11, 12]]]), new Map([["b1", [13]]])]);
  });

  it("keys the cache by book, so two books never share a page id", async () => {
    const { engine } = fakeEngine();
    const text = new LuceneTextSource(engine);

    const first = await text.pageText("b1", [7]);
    const second = await text.pageText("b2", [7]);

    expect(first.get(7)?.body).toBe("body-b1-7");
    expect(second.get(7)?.body).toBe("body-b2-7");
  });

  it("remembers a miss without re-asking, and bounds that memory too", async () => {
    const { engine, pageCalls } = fakeEngine((_book, id) => id % 2 === 0);
    const text = new LuceneTextSource(engine);

    await text.pageText("b1", [2, 3]);
    pageCalls.length = 0;
    const again = await text.pageText("b1", [2, 3]);

    expect(again.has(2)).toBe(false); // still missing, still reported as such
    expect(again.get(3)?.body).toBe("body-b1-3");
    expect(pageCalls).toEqual([]); // neither the hit nor the miss cost a round trip
  });

  it("caps the heading cache too", async () => {
    const { engine } = fakeEngine();
    const text = new LuceneTextSource(engine);

    await text.titleText("b1", range(0, 5000));
    await text.titleText("b1", range(90_000, 10));

    expect(text.cacheSize.titles).toBe(4096);
  });
});
