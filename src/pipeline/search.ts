import { parseQuery, type MatchMode } from "../search/query.js";
import { CURSOR_VERSION, decodeCursor, encodeCursor, type AfterKey } from "../search/cursor.js";
import type { SearchEngine } from "../search/engine.js";
import type { ClassifiedBook } from "../classify/types.js";
import {
  BookReaderPool,
  buildPassage,
  passageKey,
  passageNotes,
  type Passage,
  type PassageNotes,
} from "./passage.js";
import type { BookTextSource } from "../shamela/bookRepo.js";
import { ByteBudget, envelope, type BatchEnvelope, type TruncationReason } from "./batching.js";

/**
 * One batched search, shared by fiqh4_search and fiqh4_discover_issue.
 *
 * Scope is resolved to explicit book ids before the engine is touched, so the
 * fingerprint a cursor binds to covers exactly the books that were searched.
 * Narrowing the scope between pages changes the fingerprint and the stale
 * cursor is rejected rather than quietly returning a different result set.
 */

export interface BatchedSearchInput {
  /** Supplies page and heading text; without it passages come back empty. */
  text?: BookTextSource | null;
  query: string;
  mode: MatchMode;
  books: ClassifiedBook[];
  engine: SearchEngine;
  limit: number;
  cursor?: string | null | undefined;
  includeFullText: boolean;
  byteBudget: number;
  excerptRadius?: number;
}

export interface BatchedSearchOutput {
  passages: Passage[];
  /** What holds for every passage here, stated once instead of per passage. */
  notes: PassageNotes;
  batch: BatchEnvelope;
  /** Books that matched but whose database could not be read. */
  unreadable_books: Array<{ book_id: string; title: string | null; reason: string }>;
  index_fingerprint: string;
  query_hash: string;
  engine_id: string;
}

export async function runBatchedSearch(input: BatchedSearchInput): Promise<BatchedSearchOutput> {
  const query = parseQuery(input.query, input.mode);

  const byId = new Map(input.books.map((b) => [b.book_id, b]));
  // Shamela indexes a book's pages when it downloads them, so "downloaded" is
  // the whole condition for being searchable. What that leaves out is reported
  // by the coverage report the tools build, not silently dropped here.
  const searchable = input.books.filter((b) => b.downloaded);

  const scopeIds = searchable.map((b) => b.book_id).sort();
  const fingerprint = input.engine.fingerprint(scopeIds);

  let after: AfterKey | null = null;
  let delivered = 0;
  let knownTotal = -1;
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor, { fp: fingerprint, qh: query.hash });
    after = decoded.after;
    delivered = decoded.delivered;
    knownTotal = decoded.total;
  }

  const engineResult = await input.engine.search({
    query,
    bookIds: scopeIds,
    limit: input.limit,
    after,
    // The first batch counts; later batches carry the total in the cursor,
    // which the fingerprint has already pinned to this exact index state.
    withTotal: knownTotal < 0,
  });

  const totalHits = knownTotal >= 0 ? knownTotal : engineResult.totalHits;
  const result = { ...engineResult, totalHits };

  const pool = new BookReaderPool(input.text ?? null);
  const passages: Passage[] = [];
  const unreadable: BatchedSearchOutput["unreadable_books"] = [];
  const seen = new Set<string>();
  const budget = new ByteBudget(input.byteBudget);
  let reason: TruncationReason = "none";
  let lastConsumed: AfterKey | null = after;

  try {
    // One request for the whole batch's text, before the first passage is
    // built. Everything the loop below reads is then already in memory.
    await pool.warm(
      result.hits
        .map((hit) => ({ book: byId.get(hit.book_id), page_id: hit.page_id }))
        .filter((t): t is { book: ClassifiedBook; page_id: number } => t.book !== undefined),
    );

    for (const hit of result.hits) {
      const book = byId.get(hit.book_id);
      if (!book) continue;

      const key = passageKey(hit.book_id, hit.page_id);
      if (seen.has(key)) continue;

      const passage = await buildPassage(hit, book, query, pool, {
        includeFullText: input.includeFullText,
        ...(input.excerptRadius !== undefined ? { excerptRadius: input.excerptRadius } : {}),
      });

      if (!passage) {
        if (!unreadable.some((u) => u.book_id === book.book_id)) {
          unreadable.push({
            book_id: book.book_id,
            title: book.title,
            reason: book.downloaded
              ? "تعذّرت قراءة الصفحة من قاعدة بيانات الكتاب."
              : "الكتاب غير مُنزَّل.",
          });
        }
        // The hit is still consumed: resuming must not retry it forever.
        lastConsumed = { score: hit.score, doc: hit.doc };
        continue;
      }

      if (!budget.tryAdd(passage)) {
        reason = "byte_budget";
        break;
      }

      seen.add(key);
      passages.push(passage);
      lastConsumed = { score: hit.score, doc: hit.doc };
    }

    if (reason === "none" && result.hasMore) reason = "max_results_per_response";

    // More remains if the engine says so, or if the byte budget cut this batch
    // short before the engine's own page was exhausted.
    const stoppedEarly = reason === "byte_budget";
    const hasMore = result.hasMore || stoppedEarly;
    const nextAfter = stoppedEarly ? lastConsumed : result.after;

    const nextCursor =
      hasMore && nextAfter
        ? encodeCursor({
            v: CURSOR_VERSION,
            fp: fingerprint,
            qh: query.hash,
            after: nextAfter,
            delivered: delivered + passages.length,
            total: totalHits,
          })
        : null;

    return {
      passages,
      notes: passageNotes(query),
      batch: envelope({
        totalHits: result.totalHits,
        totalExact: result.totalExact,
        returned: passages.length,
        hasMore,
        nextCursor,
        reason,
      }),
      unreadable_books: unreadable,
      index_fingerprint: fingerprint,
      query_hash: query.hash,
      engine_id: input.engine.id,
    };
  } finally {
    pool.closeAll();
  }
}
