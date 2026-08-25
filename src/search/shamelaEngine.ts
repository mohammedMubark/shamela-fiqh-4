import { createHash } from "node:crypto";
import { NORMALIZER_VERSION } from "../text/normalize.js";
import { Fiqh4Error } from "../util/errors.js";
import { LuceneBridge, helperAvailable, helperClassesDir, type BridgeLaunch } from "./luceneBridge.js";
import type {
  BookHitCounts,
  EngineHit,
  EngineSearchRequest,
  EngineSearchResult,
  IndexedBookInfo,
  SearchEngine,
} from "./engine.js";
import type { ParsedQuery } from "./query.js";

/** One page as the index stores it: body text plus the editor's footnote. */
export interface PageTextRow {
  page_id: number;
  found: boolean;
  body: string | null;
  foot: string | null;
}

/** One heading as the index stores it. */
export interface TitleTextRow {
  title_id: number;
  found: boolean;
  body: string | null;
  parent: string | null;
}

/**
 * Search backed by Shamela's own Lucene index.
 *
 * Shamela has already indexed every page of every downloaded book — millions of
 * documents under `database/store/page`. Building a second index over the same
 * text would cost the user hours and gigabytes to reproduce something they
 * already have, so this engine queries theirs directly. There is no indexing
 * step and no derived index to keep in sync.
 *
 * Query terms are folded by `text/normalize.ts` using Shamela's own rules
 * before they get here; a term folded any other way cannot match what Shamela
 * stored.
 */
export class ShamelaSearchEngine implements SearchEngine {
  readonly id = "lucene" as const;
  private readonly bridge: LuceneBridge;
  private stats: { pageDocs: number; pageGeneration: string; javaVersion: string } | null = null;

  private constructor(bridge: LuceneBridge) {
    this.bridge = bridge;
  }

  static available(): boolean {
    return helperAvailable();
  }

  static async open(launch: BridgeLaunch): Promise<ShamelaSearchEngine> {
    if (!helperAvailable()) {
      throw new Fiqh4Error(
        "ENGINE_UNAVAILABLE",
        `مساعد Lucene غير مبني. ابنِه مرة واحدة بـ: npm run build:java (يحتاج JDK 21 وقت البناء فقط). المسار المتوقع: ${helperClassesDir()}`,
        `Lucene helper classes not found at ${helperClassesDir()}. Run: npm run build:java`,
        { classes_dir: helperClassesDir() },
      );
    }
    const engine = new ShamelaSearchEngine(new LuceneBridge(launch));
    await engine.refresh();
    return engine;
  }

  async refresh(): Promise<void> {
    const h = await this.bridge.send<{
      page_docs: number;
      page_generation: string | null;
      java_version: string;
    }>("health");
    if (!h || h.page_docs < 0) {
      throw new Fiqh4Error(
        "INDEX_MISSING",
        "تعذّر فتح فهرس الصفحات في database/store/page. تأكد أن المكتبة الشاملة مثبّتة وأن كتبها منزَّلة.",
        "Could not open the page index at database/store/page.",
        {},
      );
    }
    this.stats = {
      pageDocs: h.page_docs,
      pageGeneration: String(h.page_generation ?? "0"),
      javaVersion: h.java_version,
    };
  }

  get indexStats(): { pageDocs: number; pageGeneration: string; javaVersion: string } | null {
    return this.stats;
  }

  /**
   * Identity of the data a cursor was issued against.
   *
   * Shamela rewrites its index whenever books are downloaded — which happened
   * mid-session while this was being built — so the reader's generation and doc
   * count both feed the fingerprint. A cursor issued before a rebuild is then
   * rejected rather than silently resuming against different data.
   */
  fingerprint(scopeBookIds: string[]): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          engine: this.id,
          normalizer: NORMALIZER_VERSION,
          docs: this.stats?.pageDocs ?? 0,
          generation: this.stats?.pageGeneration ?? "0",
          books: [...scopeBookIds].sort(),
        }),
      )
      .digest("hex")
      .slice(0, 24);
  }

  /**
   * Shamela indexes a book's pages when it downloads them, so "indexed" and
   * "downloaded" are the same condition — and the catalogue already decides
   * that, from the book file plus `major_ondisk`.
   */
  isIndexed(): boolean {
    return true;
  }

  indexedBooks(): IndexedBookInfo[] {
    return [];
  }

  async search(req: EngineSearchRequest): Promise<EngineSearchResult> {
    const res = await this.bridge.send<{
      total_hits: number;
      total_hits_exact?: boolean;
      has_more: boolean;
      hits: Array<{ book_id: string; page_id: number; doc: number; score: number }>;
    }>("search", {
      terms: req.query.terms,
      mode: req.query.mode,
      bookIds: req.bookIds,
      limit: req.limit,
      afterDoc: req.after?.doc ?? null,
      afterScore: req.after?.score ?? null,
    });

    const hits: EngineHit[] = (res.hits ?? []).map((h) => ({
      book_id: String(h.book_id),
      page_id: Number(h.page_id),
      score: Number(h.score),
      doc: Number(h.doc),
      // Volume and printed page come from the book's SQLite file, which is
      // where Shamela keeps pagination; the index carries only text.
      part: null,
      printed_page: null,
    }));

    const last = hits[hits.length - 1];
    return {
      hits,
      totalHits: Number(res.total_hits ?? hits.length),
      totalExact: res.total_hits_exact !== false,
      hasMore: Boolean(res.has_more),
      after: res.has_more && last ? { score: last.score, doc: last.doc } : null,
    };
  }

  async countsByBook(query: ParsedQuery, bookIds: string[]): Promise<BookHitCounts> {
    const res = await this.bridge.send<{
      counts: Array<{ book_id: string; hits: number }>;
      truncated?: boolean;
    }>("counts", { terms: query.terms, mode: query.mode, bookIds });
    return {
      counts: (res.counts ?? []).map((c) => ({ book_id: String(c.book_id), hits: Number(c.hits) })),
      truncated: res.truncated === true,
    };
  }

  async pageIdsForBook(query: ParsedQuery, bookId: string, limit: number): Promise<number[]> {
    const res = await this.bridge.send<{ page_ids: number[] }>("pages", {
      terms: query.terms,
      mode: query.mode,
      bookId,
      limit,
    });
    return (res.page_ids ?? []).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  }

  /**
   * Send one fetch covering every book in the request.
   *
   * The helper resolves the whole set in a single Lucene query, so the cost of
   * reading a batch of passages is one round trip rather than one per page.
   */
  private async fetchGrouped<T>(
    cmd: "getPages" | "getTitles",
    byBook: Map<string, number[]>,
  ): Promise<Map<string, T[]>> {
    const requests = [...byBook.entries()]
      .map(([bookId, ids]) => ({ bookId: Number(bookId), ids }))
      .filter((r) => Number.isFinite(r.bookId) && r.ids.length > 0);
    if (requests.length === 0) return new Map();

    const res = await this.bridge.send<{
      groups: Array<{ book_id: string; results: T[] }>;
    }>(cmd, { requests });

    const out = new Map<string, T[]>();
    for (const group of res.groups ?? []) {
      out.set(String(group.book_id), group.results ?? []);
    }
    return out;
  }

  /** Stored page text straight from Shamela's index, for one or many books. */
  async getPagesBatched(
    byBook: Map<string, number[]>,
  ): Promise<Map<string, PageTextRow[]>> {
    return this.fetchGrouped<PageTextRow>("getPages", byBook);
  }

  /** Stored heading text, for building pages' chapter trails, for one or many books. */
  async getTitlesBatched(
    byBook: Map<string, number[]>,
  ): Promise<Map<string, TitleTextRow[]>> {
    return this.fetchGrouped<TitleTextRow>("getTitles", byBook);
  }

  /** Stored page text for a single book. */
  async getPages(bookId: string, pageIds: number[]): Promise<PageTextRow[]> {
    if (pageIds.length === 0) return [];
    const groups = await this.getPagesBatched(new Map([[bookId, pageIds]]));
    return groups.get(bookId) ?? [];
  }

  /** Stored heading text for a single book. */
  async getTitles(bookId: string, titleIds: number[]): Promise<TitleTextRow[]> {
    if (titleIds.length === 0) return [];
    const groups = await this.getTitlesBatched(new Map([[bookId, titleIds]]));
    return groups.get(bookId) ?? [];
  }

  close(): void {
    void this.bridge.close();
  }
}
