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
 */
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

  /** Ids of `wanted` that are neither cached nor already known to be missing. */
  private outstanding(
    byBook: Map<string, number[]>,
    cache: Map<string, unknown>,
    missed: Set<string>,
  ): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const [bookId, ids] of byBook) {
      const need = [...new Set(ids)].filter(
        (id) => !cache.has(`${bookId}#${id}`) && !missed.has(`${bookId}#${id}`),
      );
      if (need.length > 0) out.set(bookId, need);
    }
    return out;
  }

  /** Resolve page text for a whole batch — spanning any number of books — in one call. */
  async prefetchPages(byBook: Map<string, number[]>): Promise<void> {
    const need = this.outstanding(byBook, this.pages, this.missedPages);
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
  }

  /** Resolve heading text for a whole batch in one call. */
  async prefetchTitles(byBook: Map<string, number[]>): Promise<void> {
    const need = this.outstanding(byBook, this.titles, this.missedTitles);
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
