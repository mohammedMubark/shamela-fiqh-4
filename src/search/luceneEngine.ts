import { createHash } from "node:crypto";
import type { LibraryLocation } from "../shamela/discover.js";
import { NORMALIZER_VERSION } from "../text/normalize.js";
import { LuceneBridge, helperJarPath, javaBinFor, luceneDirFor } from "./luceneBridge.js";
import type {
  BookHitCount,
  EngineHit,
  EnginePage,
  EngineSearchRequest,
  EngineSearchResult,
  EngineTitle,
  IndexedBookInfo,
  SearchEngine,
} from "./engine.js";
import type { ParsedQuery } from "./query.js";

/**
 * Direct reader for Shamela's own Lucene indexes.
 *
 * There is no derived index here. Shamela's `database/store/page` supplies page
 * bodies, and `database/store/title` supplies title text. SQLite remains the
 * catalogue/structure source only.
 */
export class LuceneSearchEngine implements SearchEngine {
  readonly id = "lucene" as const;
  private readonly bridge: LuceneBridge;
  private booksCache: IndexedBookInfo[] = [];
  private generation = "0";
  private healthCache: Record<string, unknown> | null = null;

  private constructor(bridge: LuceneBridge) {
    this.bridge = bridge;
  }

  static available(loc: LibraryLocation): boolean {
    return helperJarPath() !== null && luceneDirFor(loc) !== null;
  }

  static javaPath(loc: LibraryLocation): string {
    return javaBinFor(loc);
  }

  static luceneDir(loc: LibraryLocation): string | null {
    return luceneDirFor(loc);
  }

  static helperJar(): string | null {
    return helperJarPath();
  }

  static async open(loc: LibraryLocation, bookIds: string[] = []): Promise<LuceneSearchEngine> {
    const engine = new LuceneSearchEngine(new LuceneBridge({ location: loc }));
    const health = await engine.health();
    engine.generation = String(health["page_commit"] ?? "0");
    if (bookIds.length > 0) await engine.refreshBooks(bookIds);
    return engine;
  }

  get runtime(): { java_path: string; lucene_dir: string; helper_jar: string; library_root: string } {
    return {
      java_path: this.bridge.javaPath,
      lucene_dir: this.bridge.luceneDir,
      helper_jar: this.bridge.jar,
      library_root: this.bridge.libraryRoot,
    };
  }

  async health(): Promise<Record<string, unknown>> {
    const h = await this.bridge.send<Record<string, unknown>>("health");
    this.healthCache = h;
    this.generation = String(h["page_commit"] ?? this.generation);
    return h;
  }

  lastHealth(): Record<string, unknown> | null {
    return this.healthCache;
  }

  fingerprint(scopeBookIds: string[]): string {
    const inScope =
      scopeBookIds.length === 0
        ? this.booksCache
        : this.booksCache.filter((b) => scopeBookIds.includes(b.book_id));
    return createHash("sha256")
      .update(
        JSON.stringify({
          engine: this.id,
          normalizer: NORMALIZER_VERSION,
          shamela_page_commit: this.generation,
          books: inScope.map((b) => `${b.book_id}@${b.page_count}@${b.indexed_at}`).sort(),
        }),
      )
      .digest("hex")
      .slice(0, 24);
  }

  async refreshBooks(bookIds: string[] = []): Promise<IndexedBookInfo[]> {
    const res = await this.bridge.send<{ books: IndexedBookInfo[]; generation: string }>("books", {
      bookIds,
    });
    this.booksCache = (res.books ?? []).map((b) => ({
      book_id: String(b.book_id),
      page_count: Number(b.page_count),
      indexed_at: String(b.indexed_at),
    }));
    this.generation = String(res.generation ?? this.generation);
    return this.booksCache;
  }

  indexedBooks(): IndexedBookInfo[] {
    return this.booksCache;
  }

  isIndexed(bookId: string): boolean {
    return this.booksCache.some((b) => b.book_id === bookId);
  }

  async search(req: EngineSearchRequest): Promise<EngineSearchResult> {
    const res = await this.bridge.send<{
      hits: Array<{
        book_id: string;
        page_id: number;
        score: number;
        doc: number;
        part: string | null;
        printed_page: number | null;
        text_original?: string;
      }>;
      total_hits: number;
      has_more: boolean;
    }>("search", {
      mode: req.query.mode,
      terms: req.query.terms,
      bookIds: req.bookIds,
      limit: req.limit,
      after: req.after,
      orderBy: req.orderBy ?? "score",
      withTotal: req.withTotal !== false,
    });

    const hits: EngineHit[] = (res.hits ?? []).map((h) => ({
      book_id: String(h.book_id),
      page_id: Number(h.page_id),
      score: Number(h.score),
      doc: Number(h.doc),
      part: h.part ?? null,
      printed_page: h.printed_page ?? null,
      text_original: h.text_original ?? "",
    }));

    const last = hits[hits.length - 1];
    return {
      hits,
      totalHits: Number(res.total_hits ?? hits.length),
      hasMore: Boolean(res.has_more),
      after: res.has_more && last ? { score: last.score, doc: last.doc } : null,
    };
  }

  async countsByBook(query: ParsedQuery, bookIds: string[]): Promise<BookHitCount[]> {
    const res = await this.bridge.send<{ counts: Array<{ book_id: string; hits: number }> }>(
      "counts",
      { mode: query.mode, terms: query.terms, bookIds },
    );
    return (res.counts ?? []).map((c) => ({ book_id: String(c.book_id), hits: Number(c.hits) }));
  }

  async pageIdsForBook(query: ParsedQuery, bookId: string, limit: number): Promise<number[]> {
    const res = await this.bridge.send<{ page_ids: number[] }>("pages", {
      mode: query.mode,
      terms: query.terms,
      bookId,
      limit,
    });
    return (res.page_ids ?? []).map(Number);
  }

  async pages(bookId: string, pageIds: number[]): Promise<EnginePage[]> {
    const res = await this.bridge.send<{
      pages: Array<{ page_id: number; found: boolean; body?: string }>;
    }>("get_pages", { bookId, pageIds });
    return (res.pages ?? []).map((p) => ({
      book_id: bookId,
      page_id: Number(p.page_id),
      found: Boolean(p.found),
      text_original: p.body ?? "",
    }));
  }

  async titles(bookId: string, titleIds: number[]): Promise<EngineTitle[]> {
    const res = await this.bridge.send<{
      titles: Array<{ title_id: number; found: boolean; text?: string; parent_id?: number | null }>;
    }>("get_titles", { bookId, titleIds });
    return (res.titles ?? []).map((t) => ({
      book_id: bookId,
      title_id: Number(t.title_id),
      found: Boolean(t.found),
      text: t.text ?? "",
      parent_id: t.parent_id === null || t.parent_id === undefined ? null : Number(t.parent_id),
    }));
  }

  close(): void {
    void this.bridge.close();
  }
}
