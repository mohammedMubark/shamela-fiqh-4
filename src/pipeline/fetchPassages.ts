import { parseQuery, firstMatchOffset, matchReason, type MatchMode } from "../search/query.js";
import { normalizeArabicWithMap } from "../text/normalize.js";
import { excerpt as cutExcerpt } from "../text/html.js";
import type { ClassifiedBook } from "../classify/types.js";
import { BookReaderPool, CONTENT_TRUST, NUMBERING_NOTE, passageKey, type Passage } from "./passage.js";
import { ByteBudget, envelope, type BatchEnvelope, type TruncationReason } from "./batching.js";
import { Fiqh4Error } from "../util/errors.js";
import type { BookTextSource } from "../shamela/bookRepo.js";

/**
 * Phase two: read the pages.
 *
 * Works book by book so a large request stays predictable, and pulls the
 * neighbouring pages around each hit because a mas'ala rarely begins and ends
 * on the page the search term happens to fall on. Neighbours are merged into
 * contiguous ranges and de-duplicated, so overlapping hits in one chapter yield
 * one passage rather than the same page repeated.
 */

export interface FetchRequestBook {
  book_id: string;
  page_ids: number[];
}

export interface FetchInput {
  /** Supplies page and heading text; without it passages come back empty. */
  text?: BookTextSource | null;
  query: string;
  mode: MatchMode;
  requests: FetchRequestBook[];
  books: ClassifiedBook[];
  /** Pages to include before and after each requested page. */
  neighbors: number;
  /** Maximum passages in this response. */
  limit: number;
  byteBudget: number;
  /** Opaque position: index into the flattened, ordered request list. */
  cursor?: string | null | undefined;
  includeFullText: boolean;
}

export interface FetchResult {
  query: string;
  match_mode: MatchMode;
  passages: Passage[];
  batch: BatchEnvelope;
  failed_books: Array<{ book_id: string; title: string | null; reason: string }>;
  /** Pages asked for that do not exist in the book. */
  missing_pages: Array<{ book_id: string; page_id: number }>;
}

interface FlatTarget {
  book: ClassifiedBook;
  page_id: number;
  /** True when this page was requested directly rather than pulled as context. */
  is_hit: boolean;
}

/** Expand each requested page into [page-n, page+n] and merge overlaps. */
function expandTargets(
  requests: FetchRequestBook[],
  byId: Map<string, ClassifiedBook>,
  neighbors: number,
  failed: FetchResult["failed_books"],
): FlatTarget[] {
  const out: FlatTarget[] = [];
  for (const req of requests) {
    const book = byId.get(req.book_id);
    if (!book) {
      failed.push({
        book_id: req.book_id,
        title: null,
        reason: "الكتاب غير موجود في فهرس المكتبة أو مستبعَد عبر ملف التجاوزات.",
      });
      continue;
    }
    if (!book.downloaded) {
      failed.push({
        book_id: req.book_id,
        title: book.title,
        reason: "الكتاب غير مُنزَّل في المكتبة الشاملة، فلا يمكن قراءة صفحاته.",
      });
      continue;
    }

    const hits = new Set(req.page_ids);
    const wanted = new Set<number>();
    for (const p of req.page_ids) {
      for (let d = -neighbors; d <= neighbors; d++) {
        const id = p + d;
        if (id >= 0) wanted.add(id);
      }
    }
    for (const page_id of [...wanted].sort((a, b) => a - b)) {
      out.push({ book, page_id, is_hit: hits.has(page_id) });
    }
  }
  return out;
}

export async function fetchPassages(input: FetchInput): Promise<FetchResult> {
  const query = parseQuery(input.query, input.mode);
  const byId = new Map(input.books.map((b) => [b.book_id, b]));
  const failed: FetchResult["failed_books"] = [];
  const missing: FetchResult["missing_pages"] = [];

  const targets = expandTargets(input.requests, byId, Math.max(0, Math.min(10, input.neighbors)), failed);

  let start = 0;
  if (input.cursor) {
    // Position is an ordinal in a list the caller fully controls, so it is
    // validated against the request shape rather than an index fingerprint.
    const parsed = Number.parseInt(Buffer.from(input.cursor, "base64url").toString("utf8"), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Fiqh4Error(
        "CURSOR_INVALID",
        "مؤشر جلب النصوص غير صالح. أعد الطلب بدون cursor.",
        "fetch_passages cursor is not a valid ordinal.",
        {},
      );
    }
    start = parsed;
  }

  const pool = new BookReaderPool(input.text ?? null);
  const passages: Passage[] = [];
  const seen = new Set<string>();
  const budget = new ByteBudget(input.byteBudget);
  let reason: TruncationReason = "none";
  let consumed = start;

  try {
    for (let i = start; i < targets.length; i++) {
      if (passages.length >= input.limit) {
        reason = "max_results_per_response";
        break;
      }

      const target = targets[i] as FlatTarget;
      const key = passageKey(target.book.book_id, target.page_id);
      if (seen.has(key)) {
        consumed = i + 1;
        continue;
      }

      const reader = pool.get(target.book);
      if (!reader) {
        if (!failed.some((f) => f.book_id === target.book.book_id)) {
          failed.push({
            book_id: target.book.book_id,
            title: target.book.title,
            reason: "تعذّر فتح قاعدة بيانات الكتاب للقراءة.",
          });
        }
        consumed = i + 1;
        continue;
      }

      const page = reader.pageById(target.page_id);
      if (page) await reader.withText([page], pool.text, target.book.book_id);
      if (!page) {
        // Only a directly requested page is worth reporting; a neighbour that
        // runs off the end of the book is expected, not an error.
        if (target.is_hit) missing.push({ book_id: target.book.book_id, page_id: target.page_id });
        consumed = i + 1;
        continue;
      }

      const original = page.text_original;
      const { text: normalised, map } = normalizeArabicWithMap(original);
      const at = firstMatchOffset(query, normalised);
      const originalOffset = at >= 0 && at < map.length ? (map[at] as number) : 0;
      const composed = original.normalize("NFC");

      const passage: Passage = {
        book_id: target.book.book_id,
        title: target.book.title,
        author: target.book.author,
        madhhab: target.book.madhhab,
        classification_source: target.book.classification_source,
        verification_status: target.book.verification_status,
        page_id: page.page_id,
        part: page.part,
        printed_page: page.printed_page,
        toc_path: await reader.tocPathWithText(page.page_id, pool.text, target.book.book_id),
        query: query.raw,
        match_mode: query.mode,
        score: 0,
        match_reason: target.is_hit
          ? matchReason(query, normalised)
          : "صفحة مجاورة أُضيفت لسياق المسألة، وقد لا تتضمن كلمات البحث.",
        text_original: input.includeFullText ? original : "",
        footnote: input.includeFullText ? page.footnote : null,
        excerpt: cutExcerpt(composed, originalOffset, 220),
        numbering_note: NUMBERING_NOTE,
        content_trust: CONTENT_TRUST,
      };

      if (!budget.tryAdd(passage)) {
        reason = "byte_budget";
        break;
      }

      seen.add(key);
      passages.push(passage);
      consumed = i + 1;
    }

    const hasMore = consumed < targets.length;
    if (reason === "none" && hasMore) reason = "max_results_per_response";

    return {
      query: query.raw,
      match_mode: query.mode,
      passages,
      batch: envelope({
        totalHits: targets.length,
        returned: passages.length,
        hasMore,
        nextCursor: hasMore ? Buffer.from(String(consumed), "utf8").toString("base64url") : null,
        reason,
      }),
      failed_books: failed,
      missing_pages: missing,
    };
  } finally {
    pool.closeAll();
  }
}
