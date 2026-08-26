import type { MatchMode, ParsedQuery } from "./query.js";
import type { AfterKey } from "./cursor.js";

/**
 * The contract both engines implement. Everything above this line — tools,
 * pipeline, export — is engine-agnostic, so the optional Lucene backend is a
 * drop-in swap rather than a parallel code path.
 */

export type EngineId = "node-fts5" | "lucene";

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
  /** Number of matching pages in scope. Exact unless `totalExact` says otherwise. */
  totalHits: number;
  /**
   * False when the engine could not restrict the count to the requested books,
   * so `totalHits` is an upper bound over a wider set than was asked for.
   *
   * Only reachable on an index whose book field cannot be identified; the
   * response says so rather than presenting the wider number as the answer.
   */
  totalExact: boolean;
  hasMore: boolean;
  /** Resume key for the next page, or null when exhausted. */
  after: AfterKey | null;
}

/** Per-book hit totals — the terrain map phase 1 needs without paging results. */
export interface BookHitCount {
  book_id: string;
  hits: number;
}

export interface BookHitCounts {
  counts: BookHitCount[];
  /**
   * True when the engine stopped scanning before it had seen every match, so
   * the counts are a floor rather than a total.
   *
   * The helper has always had a bounded fallback for the case where it cannot
   * push the book filter into Lucene, and it has always reported hitting that
   * bound — but the flag was dropped on the way back, and a partial terrain map
   * was presented as an exact one. Carrying it is what invariant 6 requires:
   * a response may be partial, never silently partial.
   */
  truncated: boolean;
}

export interface IndexedBookInfo {
  book_id: string;
  page_count: number;
  indexed_at: string;
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
  countsByBook(query: ParsedQuery, bookIds: string[]): Promise<BookHitCounts>;
  /** Up to `limit` matching page ids in one book, in page order. */
  pageIdsForBook(query: ParsedQuery, bookId: string, limit: number): Promise<number[]>;
  indexedBooks(): IndexedBookInfo[];
  isIndexed(bookId: string): boolean;
  close(): void;
}

export type { MatchMode, ParsedQuery, AfterKey };
