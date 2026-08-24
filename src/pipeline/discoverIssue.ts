import { parseQuery, type MatchMode } from "../search/query.js";
import type { SearchEngine } from "../search/engine.js";
import type { ClassifiedBook, Madhhab } from "../classify/types.js";
import { MADHHAB_AR, MADHHAB_VALUES } from "../classify/types.js";
import { CURSOR_VERSION, decodeCursor, encodeCursor } from "../search/cursor.js";
import { envelope, type BatchEnvelope, type TruncationReason } from "./batching.js";

/**
 * Phase one: map the terrain.
 *
 * Answers "which books, and roughly where in them, does this issue appear?"
 * using grouped counts rather than by paging through every hit. The totals are
 * exact and cover the whole scope even when the per-book listing is batched, so
 * the caller always knows the true size of what it is about to fetch.
 */

export interface BookDiscovery {
  book_id: string;
  title: string | null;
  author: string | null;
  madhhab: Madhhab;
  classification_source: string;
  verification_status: string;
  ambiguity_reasons: string[];
  hits: number;
  page_ids: number[];
  page_ids_truncated: boolean;
}

export interface DiscoveryResult {
  query: string;
  match_mode: MatchMode;
  query_hash: string;
  index_fingerprint: string;
  engine_id: string;
  totals: {
    total_hits: number;
    books_with_hits: number;
    books_searched: number;
    by_madhhab: Array<{ madhhab: Madhhab; madhhab_ar: string; books: number; hits: number }>;
  };
  books: BookDiscovery[];
  batch: BatchEnvelope;
  coverage: {
    books_in_scope: number;
    books_not_downloaded: Array<{ book_id: string; title: string | null }>;
    books_not_indexed: Array<{ book_id: string; title: string | null }>;
  };
}

export interface DiscoverInput {
  query: string;
  mode: MatchMode;
  books: ClassifiedBook[];
  engine: SearchEngine;
  /** Books per response batch. */
  limit: number;
  cursor?: string | null | undefined;
  /** Sample of matching page ids to list per book. */
  pageSample: number;
}

export async function discoverIssue(input: DiscoverInput): Promise<DiscoveryResult> {
  const query = parseQuery(input.query, input.mode);

  const notDownloaded = input.books
    .filter((b) => !b.downloaded)
    .map((b) => ({ book_id: b.book_id, title: b.title }));
  const searchable = input.books.filter((b) => b.downloaded);
  const indexed = searchable.filter((b) => input.engine.isIndexed(b.book_id));
  const notIndexed = searchable
    .filter((b) => !input.engine.isIndexed(b.book_id))
    .map((b) => ({ book_id: b.book_id, title: b.title }));

  const scopeIds = indexed.map((b) => b.book_id).sort();
  const fingerprint = input.engine.fingerprint(scopeIds);

  // Grouped counts over the entire scope — this is the exact terrain.
  const counts = await input.engine.countsByBook(query, scopeIds);
  const byId = new Map(indexed.map((b) => [b.book_id, b]));
  const withHits = counts.filter((c) => c.hits > 0 && byId.has(c.book_id));

  const totalHits = withHits.reduce((sum, c) => sum + c.hits, 0);

  // Aggregate by madhhab across the FULL scope, not just this batch.
  const madhhabTotals = new Map<Madhhab, { books: number; hits: number }>();
  for (const c of withHits) {
    const book = byId.get(c.book_id)!;
    const cur = madhhabTotals.get(book.madhhab) ?? { books: 0, hits: 0 };
    cur.books += 1;
    cur.hits += c.hits;
    madhhabTotals.set(book.madhhab, cur);
  }

  // Batch the per-book listing. The cursor position is an index into the
  // deterministically ordered `withHits` array; `doc` carries that index.
  let start = 0;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor, { fp: fingerprint, qh: query.hash });
    start = decoded.after.doc;
  }

  const slice = withHits.slice(start, start + input.limit);
  const hasMore = start + slice.length < withHits.length;

  const books: BookDiscovery[] = [];
  for (const c of slice) {
    const book = byId.get(c.book_id)!;
    const pageIds = await input.engine.pageIdsForBook(query, c.book_id, input.pageSample);
    books.push({
      book_id: book.book_id,
      title: book.title,
      author: book.author,
      madhhab: book.madhhab,
      classification_source: book.classification_source,
      verification_status: book.verification_status,
      ambiguity_reasons: book.ambiguity_reasons,
      hits: c.hits,
      page_ids: pageIds,
      page_ids_truncated: c.hits > pageIds.length,
    });
  }

  const reason: TruncationReason = hasMore ? "book_limit" : "none";
  const nextCursor = hasMore
    ? encodeCursor({
        v: CURSOR_VERSION,
        fp: fingerprint,
        qh: query.hash,
        after: { score: 0, doc: start + slice.length },
        delivered: start + slice.length,
        total: withHits.length,
      })
    : null;

  return {
    query: query.raw,
    match_mode: query.mode,
    query_hash: query.hash,
    index_fingerprint: fingerprint,
    engine_id: input.engine.id,
    totals: {
      total_hits: totalHits,
      books_with_hits: withHits.length,
      books_searched: scopeIds.length,
      by_madhhab: MADHHAB_VALUES.filter((m) => madhhabTotals.has(m)).map((m) => ({
        madhhab: m,
        madhhab_ar: MADHHAB_AR[m],
        books: madhhabTotals.get(m)!.books,
        hits: madhhabTotals.get(m)!.hits,
      })),
    },
    books,
    batch: envelope({
      totalHits: withHits.length,
      returned: books.length,
      hasMore,
      nextCursor,
      reason,
    }),
    coverage: {
      books_in_scope: input.books.length,
      books_not_downloaded: notDownloaded,
      books_not_indexed: notIndexed,
    },
  };
}
