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
 * **Both caches are bounded**, because one "operation" can be a full export
 * sweeping the whole library. Measured on the 77,000-page fixture (heap after
 * a forced GC, not RSS): an unbounded page cache still held 33.7 MB once a
 * 70,035-hit export had finished — every page body the sweep had ever read,
 * which is precisely what the near-constant-memory requirement forbids. With
 * the bound the same export ends 0.1 MB *below* where it started.
 * Eviction is insertion-order:
 * reuse here is local (neighbouring pages, the chapter trail of the hit being
 * rendered), so the oldest entry is reliably the least useful one.
 *
 * Headings get the larger budget: they are short, and a chapter trail is
 * re-read for every hit in that chapter.
 */
const MAX_CACHED_PAGES = 1_024;
const MAX_CACHED_TITLES = 4_096;

export class LuceneTextSource implements BookTextSource {
  private readonly engine: ShamelaSearchEngine;
  private readonly pages = new Map<string, { body: string; foot: string | null }>();
  private readonly titles = new Map<string, string>();

  constructor(engine: ShamelaSearchEngine) {
    this.engine = engine;
  }

  /** Cached entry counts. Exposed so the bound itself can be tested. */
  get cacheSize(): { pages: number; titles: number } {
    return { pages: this.pages.size, titles: this.titles.size };
  }

  /**
   * Map preserves insertion order, so the first key is the oldest. Deleting
   * one entry per insertion keeps the map at its cap without a sweep.
   */
  private static remember<T>(cache: Map<string, T>, key: string, value: T, cap: number): void {
    cache.set(key, value);
    while (cache.size > cap) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  async pageText(
    bookId: string,
    pageIds: number[],
  ): Promise<Map<number, { body: string; foot: string | null }>> {
    const out = new Map<number, { body: string; foot: string | null }>();
    const missing: number[] = [];

    for (const id of pageIds) {
      const cached = this.pages.get(`${bookId}#${id}`);
      if (cached) out.set(id, cached);
      else missing.push(id);
    }
    if (missing.length === 0) return out;

    try {
      for (const row of await this.engine.getPages(bookId, missing)) {
        if (!row.found || row.body === null) continue;
        const value = { body: row.body, foot: row.foot };
        LuceneTextSource.remember(this.pages, `${bookId}#${row.page_id}`, value, MAX_CACHED_PAGES);
        out.set(row.page_id, value);
      }
    } catch (e) {
      // A book whose text cannot be read is reported as unreadable upstream;
      // it must not take the whole search down with it.
      log.warn("could not read page text from Shamela's index", {
        book_id: bookId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return out;
  }

  async titleText(bookId: string, titleIds: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const missing: number[] = [];

    for (const id of titleIds) {
      const cached = this.titles.get(`${bookId}#${id}`);
      if (cached !== undefined) out.set(id, cached);
      else missing.push(id);
    }
    if (missing.length === 0) return out;

    try {
      for (const row of await this.engine.getTitles(bookId, missing)) {
        if (!row.found || row.body === null) continue;
        LuceneTextSource.remember(
          this.titles,
          `${bookId}#${row.title_id}`,
          row.body,
          MAX_CACHED_TITLES,
        );
        out.set(row.title_id, row.body);
      }
    } catch (e) {
      log.warn("could not read heading text from Shamela's index", {
        book_id: bookId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return out;
  }
}
