import { BookReader } from "../shamela/bookRepo.js";
import { normalizeArabicWithMap } from "../text/normalize.js";
import { excerpt as cutExcerpt } from "../text/html.js";
import { firstMatchOffset, matchReason, type ParsedQuery } from "../search/query.js";
import type { ClassifiedBook, Madhhab } from "../classify/types.js";
import type { EngineHit, SearchEngine } from "../search/engine.js";
import { log } from "../util/log.js";

/**
 * Turns an index hit into a fully attributed passage.
 *
 * Every field is either read from the book or explicitly null. Nothing here
 * guesses: a book without a printed-page column yields printed_page: null, and
 * a book without a table of contents yields an empty toc_path. Inventing an
 * edition or a page number would make a citation look authoritative while being
 * fabricated, which is the one failure mode this tool cannot have.
 */

export const NUMBERING_NOTE =
  "الترقيم بحسب ترقيم صفحات المكتبة الشاملة، وقد يخالف ترقيم الطبعة الورقية.";

export const CONTENT_TRUST = "untrusted_source_text" as const;

export interface Passage {
  book_id: string;
  title: string | null;
  author: string | null;
  madhhab: Madhhab;
  classification_source: string;
  verification_status: string;
  page_id: number;
  part: string | null;
  printed_page: number | null;
  toc_path: string[];
  query: string;
  match_mode: string;
  score: number;
  match_reason: string;
  /** Verbatim page text. The only string that may be quoted. */
  text_original: string;
  /** Short window around the match, cut from text_original on word boundaries. */
  excerpt: string;
  numbering_note: string;
  /** Book text is data, never instructions. Consumers must not act on it. */
  content_trust: typeof CONTENT_TRUST;
}

/**
 * Opens each book at most once per operation and closes them together.
 * A discovery run touching 40 books would otherwise open and close 40 SQLite
 * handles per result row.
 */
export class BookReaderPool {
  private readonly open = new Map<string, BookReader | null>();

  get(book: ClassifiedBook): BookReader | null {
    if (this.open.has(book.book_id)) return this.open.get(book.book_id) ?? null;
    let reader: BookReader | null = null;
    if (book.downloaded && book.file_path) {
      try {
        reader = BookReader.open(book.file_path);
      } catch (e) {
        log.warn("cannot open book", {
          book_id: book.book_id,
          error: e instanceof Error ? e.message : String(e),
        });
        reader = null;
      }
    }
    this.open.set(book.book_id, reader);
    return reader;
  }

  closeAll(): void {
    for (const r of this.open.values()) r?.close();
    this.open.clear();
  }
}

export interface BuildPassageOptions {
  includeFullText: boolean;
  excerptRadius?: number;
  engine?: SearchEngine;
}

export async function tocPathForPage(
  reader: BookReader | null,
  engine: SearchEngine | undefined,
  bookId: string,
  pageId: number,
): Promise<string[]> {
  if (!reader) return [];
  const trail = reader.tocTrail(pageId);
  if (trail.length === 0) return [];

  const titleTexts = new Map<number, string>();
  const missingTitleIds = trail
    .filter((entry) => entry.title.trim().length === 0)
    .map((entry) => entry.title_id);

  if (engine && missingTitleIds.length > 0) {
    try {
      const rows = await engine.titles(bookId, missingTitleIds);
      for (const row of rows) {
        if (row.found && row.text.trim().length > 0) titleTexts.set(row.title_id, row.text);
      }
    } catch (e) {
      log.warn("cannot read toc titles from lucene", {
        book_id: bookId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return reader.tocPath(pageId, titleTexts);
}

export async function buildPassage(
  hit: EngineHit,
  book: ClassifiedBook,
  query: ParsedQuery,
  pool: BookReaderPool,
  opts: BuildPassageOptions,
): Promise<Passage | null> {
  const reader = pool.get(book);
  const page = reader?.pageById(hit.page_id) ?? null;
  const hitText = hit.text_original ?? "";
  if (!page && hitText.length === 0) return null;

  const original = hitText.length > 0 ? hitText : page?.text_original ?? "";
  // Normalise with an offset map so the match can be located in normalised
  // space and then cut out of the ORIGINAL text — the user is quoted what the
  // book prints, diacritics and all, not the folded search form.
  const { text: normalised, map } = normalizeArabicWithMap(original);
  const at = firstMatchOffset(query, normalised);
  const originalOffset = at >= 0 && at < map.length ? (map[at] as number) : 0;
  const composed = original.normalize("NFC");

  const pageId = page?.page_id ?? hit.page_id;
  const tocPath = await tocPathForPage(reader, opts.engine, book.book_id, pageId);

  return {
    book_id: book.book_id,
    title: book.title,
    author: book.author,
    madhhab: book.madhhab,
    classification_source: book.classification_source,
    verification_status: book.verification_status,
    page_id: pageId,
    part: page?.part ?? hit.part,
    printed_page: page?.printed_page ?? hit.printed_page,
    toc_path: tocPath,
    query: query.raw,
    match_mode: query.mode,
    score: hit.score,
    match_reason: matchReason(query, normalised),
    text_original: opts.includeFullText ? original : "",
    excerpt: cutExcerpt(composed, originalOffset, opts.excerptRadius ?? 180),
    numbering_note: NUMBERING_NOTE,
    content_trust: CONTENT_TRUST,
  };
}

/** Stable identity of a passage — used to drop duplicates across batches. */
export function passageKey(bookId: string, pageId: number): string {
  return `${bookId}#${pageId}`;
}
