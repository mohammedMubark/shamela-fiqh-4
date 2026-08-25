import type { MatchMode, ParsedQuery } from "./query.js";
import type { AfterKey } from "./cursor.js";

/**
 * The contract implemented by the direct Shamela Lucene backend. Everything
 * above this line — tools, pipeline, export — speaks in pages and titles rather
 * than Lucene classes, keeping the corpus access isolated.
 */

export type EngineId = "lucene";

/** One index entry: a page, located and scored. */
export interface EngineHit {
  book_id: string;
  page_id: number;
  /** Higher is more relevant. Engine-relative; never compared across engines. */
  score: number;
  /** Engine-local document id — the tiebreaker that makes paging total. */
  doc: number;
  part: string | null;
  printed_page: number | null;
  /** Stored Lucene body. This is original source text, never normalized search text. */
  text_original?: string;
}

export interface EngineSearchRequest {
  query: ParsedQuery;
  /** Books to search. Empty array means "every indexed book". */
  bookIds: string[];
  limit: number;
  after: AfterKey | null;
  /**
   * "score" ranks by relevance — what an interactive search wants, but it
   * forces the engine to consider every match to order them.
   * "doc" walks index order instead, letting the keyset predicate seek straight
   * to the resume point. Exhaustive sweeps use it because relevance order is
   * meaningless when you are taking every row anyway.
   */
  orderBy?: "score" | "doc";
  /**
   * Skip the exact-count query. Callers that already know the total (from a
   * cursor issued against this same index) pass false to avoid recounting the
   * whole match set on every batch.
   */
  withTotal?: boolean;
}

export interface EngineSearchResult {
  hits: EngineHit[];
  /** Exact number of matching pages in scope — never an estimate. */
  totalHits: number;
  hasMore: boolean;
  /** Resume key for the next page, or null when exhausted. */
  after: AfterKey | null;
}

/** Per-book hit totals — the terrain map phase 1 needs without paging results. */
export interface BookHitCount {
  book_id: string;
  hits: number;
}

export interface IndexedBookInfo {
  book_id: string;
  page_count: number;
  indexed_at: string;
}

export interface EnginePage {
  book_id: string;
  page_id: number;
  found: boolean;
  text_original: string;
}

export interface EngineTitle {
  book_id: string;
  title_id: number;
  found: boolean;
  text: string;
  parent_id: number | null;
}

export interface SearchEngine {
  readonly id: EngineId;
  /**
   * Identity of the data behind this engine. Cursors embed it, so anything that
   * changes result ordering must change the fingerprint.
   */
  fingerprint(scopeBookIds: string[]): string;
  search(req: EngineSearchRequest): Promise<EngineSearchResult>;
  /**
   * Exact hit count per book across the whole scope. Answering phase 1 by
   * paging through every hit would cost one pass over the corpus; a grouped
   * count answers "which books discuss this" in a single query.
   */
  countsByBook(query: ParsedQuery, bookIds: string[]): Promise<BookHitCount[]>;
  /** Up to `limit` matching page ids in one book, in page order. */
  pageIdsForBook(query: ParsedQuery, bookId: string, limit: number): Promise<number[]>;
  /** Fetch page bodies from the immutable Lucene `body` stored field. */
  pages(bookId: string, pageIds: number[]): Promise<EnginePage[]>;
  /** Fetch table-of-contents titles from Shamela's `title` Lucene index. */
  titles(bookId: string, titleIds: number[]): Promise<EngineTitle[]>;
  indexedBooks(): IndexedBookInfo[];
  isIndexed(bookId: string): boolean;
  close(): void;
}

export type { MatchMode, ParsedQuery, AfterKey };
