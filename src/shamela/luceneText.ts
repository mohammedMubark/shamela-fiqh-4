import type { BookTextSource } from "./bookRepo.js";
import type { ShamelaSearchEngine } from "../search/shamelaEngine.js";
import { log } from "../util/log.js";

/**
 * Supplies book text from Shamela's Lucene index.
 *
 * Requests are batched and memoised per operation: fetching a page's chapter
 * trail touches the same few headings for every hit in a chapter, and a
 * discovery run over forty books would otherwise re-ask for them constantly.
 * The cache lives as long as the caller's operation, not the process, so a
 * reindex by Shamela is never served from stale memory.
 *
 * Callers that already know the whole set they will need — a search batch knows
 * every hit before it builds a single passage — should `prefetch` it first. One
 * round trip then serves the entire batch, and the per-page `pageText` calls
 * that follow are pure cache hits. Without that, building fifty passages costs
 * fifty round trips for text one query could have returned.
 *
 * **Every cache here is bounded**, because one "operation" can be a full export
 * sweeping the whole library. Measured on the 77,000-page fixture (heap after a
 * forced GC, not RSS): unbounded, the page cache still held 33.7 MB once a
 * 70,035-hit export had finished — every page body the sweep had ever read,
 * which is what the near-constant-memory requirement forbids. Bounded, the same
 * export ends 0.1 MB *below* where it started.
 *
 * The bound never costs a caller its own batch: a prefetch raises the ceiling to
 * fit whatever it is fetching, so `warm()` followed by per-page reads stays a
 * pure cache hit however large the batch. What the bound evicts is the batch
 * before it — insertion-order, oldest first — which is precisely the text no
 * one is going to ask for again.
 */
const MAX_CACHED_PAGES = 1_024;
const MAX_CACHED_TITLES = 4_096;
const MAX_REMEMBERED_MISSES = 8_192;

export class LuceneTextSource implements BookTextSource {
  private readonly engine: ShamelaSearchEngine;
  private readonly pages = new Map<string, { body: string; foot: string | null }>();
  private readonly titles = new Map<string, string>();
  /** Ids already asked for and not found, so a miss is not re-fetched per passage. */
  private readonly missedPages = new Set<string>();
  private readonly missedTitles = new Set<string>();

  constructor(engine: ShamelaSearchEngine) {
    this.engine = engine;
  }

  /** Cached entry counts. Exposed so the bounds themselves can be tested. */
  get cacheSize(): { pages: number; titles: number; misses: number } {
    return {
      pages: this.pages.size,
      titles: this.titles.size,
      misses: this.missedPages.size + this.missedTitles.size,
    };
  }

  /**
   * Trim to `cap`, oldest first. Map and Set both preserve insertion order, so
   * the first key is the least recently fetched — and reuse here is local (a
   * neighbouring page, the chapter trail of the passage being rendered), which
   * makes the oldest entry reliably the least useful one.
   */
  private static trim(cache: Map<string, unknown> | Set<string>, cap: number): void {
    while (cache.size > cap) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  /**
   * The ceiling to trim a cache to after fetching `fetching` entries.
   *
   * A batch larger than the standing cap must survive whole, or the `warm()`
   * that fetched it would evict its own text before `buildPassage` reads it —
   * a bound that silently blanks passages is worse than no bound at all.
   */
  private static ceiling(cap: number, fetching: number): number {
    return Math.max(cap, fetching);
  }

  /**
   * Ids of `wanted` that are neither cached nor already known to be missing.
   *
   * A hit is also *touched* — deleted and re-set — so it moves to the end of
   * the insertion order. That is what makes eviction least-recently-used rather
   * than first-in-first-out, and it is what guarantees that everything the
   * caller asked for this time outlives the trim that follows.
   */
  private outstanding(
    byBook: Map<string, number[]>,
    cache: Map<string, unknown>,
    missed: Set<string>,
  ): { need: Map<string, number[]>; requested: number } {
    const need = new Map<string, number[]>();
    let requested = 0;
    for (const [bookId, ids] of byBook) {
      const unique = [...new Set(ids)];
      requested += unique.length;
      const missing: number[] = [];
      for (const id of unique) {
        const key = `${bookId}#${id}`;
        if (cache.has(key)) {
          const value = cache.get(key);
          cache.delete(key);
          cache.set(key, value);
        } else if (!missed.has(key)) {
          missing.push(id);
        }
      }
      if (missing.length > 0) need.set(bookId, missing);
    }
    return { need, requested };
  }

  /** Resolve page text for a whole batch — spanning any number of books — in one call. */
  async prefetchPages(byBook: Map<string, number[]>): Promise<void> {
    const { need, requested } = this.outstanding(byBook, this.pages, this.missedPages);
    if (need.size === 0) return;
    try {
      const groups = await this.engine.getPagesBatched(need);
      for (const [bookId, rows] of groups) {
        for (const row of rows) {
          const key = `${bookId}#${row.page_id}`;
          if (!row.found || row.body === null) {
            this.missedPages.add(key);
            continue;
          }
          this.pages.set(key, { body: row.body, foot: row.foot });
        }
      }
    } catch (e) {
      // A book whose text cannot be read is reported as unreadable upstream;
      // it must not take the whole search down with it.
      log.warn("could not read page text from Shamela's index", {
        books: [...need.keys()],
        error: e instanceof Error ? e.message : String(e),
      });
    }
    LuceneTextSource.trim(this.pages, LuceneTextSource.ceiling(MAX_CACHED_PAGES, requested));
    LuceneTextSource.trim(this.missedPages, MAX_REMEMBERED_MISSES);
  }

  /** Resolve heading text for a whole batch in one call. */
  async prefetchTitles(byBook: Map<string, number[]>): Promise<void> {
    const { need, requested } = this.outstanding(byBook, this.titles, this.missedTitles);
    if (need.size === 0) return;
    try {
      const groups = await this.engine.getTitlesBatched(need);
      for (const [bookId, rows] of groups) {
        for (const row of rows) {
          const key = `${bookId}#${row.title_id}`;
          if (!row.found || row.body === null) {
            this.missedTitles.add(key);
            continue;
          }
          this.titles.set(key, row.body);
        }
      }
    } catch (e) {
      log.warn("could not read heading text from Shamela's index", {
        books: [...need.keys()],
        error: e instanceof Error ? e.message : String(e),
      });
    }
    LuceneTextSource.trim(this.titles, LuceneTextSource.ceiling(MAX_CACHED_TITLES, requested));
    LuceneTextSource.trim(this.missedTitles, MAX_REMEMBERED_MISSES);
  }

  async pageText(
    bookId: string,
    pageIds: number[],
  ): Promise<Map<number, { body: string; foot: string | null }>> {
    await this.prefetchPages(new Map([[bookId, pageIds]]));
    const out = new Map<number, { body: string; foot: string | null }>();
    for (const id of pageIds) {
      const cached = this.pages.get(`${bookId}#${id}`);
      if (cached) out.set(id, cached);
    }
    return out;
  }

  async titleText(bookId: string, titleIds: number[]): Promise<Map<number, string>> {
    await this.prefetchTitles(new Map([[bookId, titleIds]]));
    const out = new Map<number, string>();
    for (const id of titleIds) {
      const cached = this.titles.get(`${bookId}#${id}`);
      if (cached !== undefined) out.set(id, cached);
    }
    return out;
  }
}
