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
 */
export class LuceneTextSource implements BookTextSource {
  private readonly engine: ShamelaSearchEngine;
  private readonly pages = new Map<string, { body: string; foot: string | null }>();
  private readonly titles = new Map<string, string>();

  constructor(engine: ShamelaSearchEngine) {
    this.engine = engine;
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
        this.pages.set(`${bookId}#${row.page_id}`, value);
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
        this.titles.set(`${bookId}#${row.title_id}`, row.body);
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
