import { createHash } from "node:crypto";
import { join } from "node:path";
import { NORMALIZER_VERSION } from "../text/normalize.js";
import { defaultIndexDir } from "../util/paths.js";
import { Fiqh4Error } from "../util/errors.js";
import { LuceneBridge, luceneJarPath } from "./luceneBridge.js";
import type {
  BookHitCount,
  EngineHit,
  EngineSearchRequest,
  EngineSearchResult,
  IndexedBookInfo,
  SearchEngine,
} from "./engine.js";
import type { ParsedQuery } from "./query.js";

/**
 * Optional Lucene-backed engine.
 *
 * Paging uses Lucene's own `searchAfter`, which is the reason this backend
 * exists: on a corpus of thousands of books it resumes from a ScoreDoc instead
 * of re-collecting everything before the requested page.
 *
 * The helper indexes text that Node has already normalised, so both engines
 * tokenise identically and a query cannot mean two different things depending
 * on which backend answered it.
 */
export class LuceneSearchEngine implements SearchEngine {
  readonly id = "lucene" as const;
  private readonly bridge: LuceneBridge;
  private readonly dir: string;
  private booksCache: IndexedBookInfo[] | null = null;
  private generation = "0";

  private constructor(bridge: LuceneBridge, dir: string) {
    this.bridge = bridge;
    this.dir = dir;
  }

  static available(): boolean {
    return luceneJarPath() !== null;
  }

  static async open(indexDir?: string): Promise<LuceneSearchEngine> {
    const jar = luceneJarPath();
    if (!jar) {
      throw new Fiqh4Error(
        "ENGINE_UNAVAILABLE",
        "محرك Lucene غير مفعّل: لم يُضبط FIQH4_LUCENE_JAR أو الملف غير موجود. ابنِ الجسر بـ npm run java:build، أو استخدم محرك Node الافتراضي.",
        "Lucene engine unavailable: FIQH4_LUCENE_JAR is unset or missing.",
        {},
      );
    }
    const dir = join(indexDir ?? defaultIndexDir(), "lucene");
    const engine = new LuceneSearchEngine(new LuceneBridge(jar), dir);
    const health = await engine.bridge.send<{ lucene_version: string; generation?: string }>(
      "health",
      { indexDir: dir },
    );
    engine.generation = String(health.generation ?? "0");
    return engine;
  }

  get indexDir(): string {
    return this.dir;
  }

  fingerprint(scopeBookIds: string[]): string {
    const books = this.booksCache ?? [];
    const inScope =
      scopeBookIds.length === 0
        ? books
        : books.filter((b) => scopeBookIds.includes(b.book_id));
    return createHash("sha256")
      .update(
        JSON.stringify({
          engine: this.id,
          normalizer: NORMALIZER_VERSION,
          generation: this.generation,
          books: inScope
            .map((b) => `${b.book_id}@${b.indexed_at}`)
            .sort(),
        }),
      )
      .digest("hex")
      .slice(0, 24);
  }

  async refreshBooks(): Promise<IndexedBookInfo[]> {
    const res = await this.bridge.send<{ books: IndexedBookInfo[]; generation: string }>("health", {
      indexDir: this.dir,
    });
    this.booksCache = res.books ?? [];
    this.generation = String(res.generation ?? this.generation);
    return this.booksCache;
  }

  indexedBooks(): IndexedBookInfo[] {
    return this.booksCache ?? [];
  }

  isIndexed(bookId: string): boolean {
    return (this.booksCache ?? []).some((b) => b.book_id === bookId);
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
      }>;
      total_hits: number;
      has_more: boolean;
    }>("search", {
      indexDir: this.dir,
      mode: req.query.mode,
      terms: req.query.terms,
      bookIds: req.bookIds,
      limit: req.limit,
      after: req.after,
    });

    const hits: EngineHit[] = (res.hits ?? []).map((h) => ({
      book_id: String(h.book_id),
      page_id: Number(h.page_id),
      score: Number(h.score),
      doc: Number(h.doc),
      part: h.part ?? null,
      printed_page: h.printed_page ?? null,
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
      { indexDir: this.dir, mode: query.mode, terms: query.terms, bookIds },
    );
    return (res.counts ?? []).map((c) => ({ book_id: String(c.book_id), hits: Number(c.hits) }));
  }

  async pageIdsForBook(query: ParsedQuery, bookId: string, limit: number): Promise<number[]> {
    const res = await this.bridge.send<{ page_ids: number[] }>("pages", {
      indexDir: this.dir,
      mode: query.mode,
      terms: query.terms,
      bookId,
      limit,
    });
    return (res.page_ids ?? []).map(Number);
  }

  /** Feed a batch of already-normalised pages to the helper. */
  async indexBatch(
    docs: Array<{
      book_id: string;
      page_id: number;
      part: string | null;
      printed_page: number | null;
      text_search: string;
    }>,
    opts: { reset?: boolean; commit?: boolean } = {},
  ): Promise<{ indexed: number }> {
    return this.bridge.send<{ indexed: number }>("index", {
      indexDir: this.dir,
      reset: opts.reset === true,
      commit: opts.commit !== false,
      docs,
    });
  }

  close(): void {
    void this.bridge.close();
  }
}
