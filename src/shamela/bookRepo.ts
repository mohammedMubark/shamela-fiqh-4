import { openReadOnly, str, num, type ReadOnlyDb } from "./sqlite.js";
import { probeBook, quoteIdent, type BookProfile } from "./schemaProbe.js";
import { htmlToText } from "../text/html.js";
import { Fiqh4Error } from "../util/errors.js";

/**
 * Reads one book.
 *
 * Shamela 4 splits a book across two stores: its SQLite file holds pagination
 * (volume, printed page, the heading tree), while the text of both pages and
 * headings lives in Shamela's Lucene index. So this reader takes coordinates
 * from SQLite and text from a supplied text source, and callers see one object
 * either way.
 *
 * The text source is injected rather than opened here, because a single Lucene
 * helper process serves every book and opening one per book would be absurd.
 * Passing none yields pages with empty text — which is exactly what a book
 * whose content was never downloaded should produce.
 */

/** Supplies page and heading text for one book. Backed by Shamela's index. */
export interface BookTextSource {
  pageText(bookId: string, pageIds: number[]): Promise<Map<number, { body: string; foot: string | null }>>;
  titleText(bookId: string, titleIds: number[]): Promise<Map<number, string>>;
}

export interface PageRow {
  page_id: number;
  /** Readable text exactly as the book has it. The only string ever quoted. */
  text_original: string;
  /** The editor's footnote, when Shamela records one. Not the author's words. */
  footnote: string | null;
  /** Volume / juz' as recorded by Shamela, or null when the column is absent. */
  part: string | null;
  /** Printed page number when Shamela records one, else null. Never guessed. */
  printed_page: number | null;
}

export interface TocEntry {
  /** Row id, used to fetch the heading's words from Shamela's title index. */
  title_id: number;
  page_id: number;
  title: string;
  level: number;
}

export class BookReader {
  readonly path: string;
  readonly profile: BookProfile;
  private readonly db: ReadOnlyDb;
  private tocCache: TocEntry[] | null = null;

  private constructor(db: ReadOnlyDb, profile: BookProfile) {
    this.db = db;
    this.path = db.path;
    this.profile = profile;
  }

  static open(path: string): BookReader {
    const db = openReadOnly(path);
    try {
      return new BookReader(db, probeBook(db));
    } catch (e) {
      db.close();
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }

  private selectList(): string {
    const p = this.profile;
    return [
      `${quoteIdent(p.pageId)} AS page_id`,
      p.pageText ? `${quoteIdent(p.pageText)} AS body` : `NULL AS body`,
      p.pagePart ? `${quoteIdent(p.pagePart)} AS part` : `NULL AS part`,
      p.pagePrinted ? `${quoteIdent(p.pagePrinted)} AS printed_page` : `NULL AS printed_page`,
    ].join(", ");
  }

  private toPage(r: Record<string, unknown>): PageRow {
    return {
      page_id: Number(r["page_id"]),
      // Empty unless a text source fills it in; on Shamela 4 the column is null.
      text_original: htmlToText(r["body"] as string | null),
      footnote: null,
      part: str(r["part"]),
      printed_page: num(r["printed_page"]),
    };
  }

  /**
   * Fill in text for pages already read from SQLite.
   *
   * One batched call per group of pages, not one per page: the helper resolves
   * a whole set of ids in a single Lucene query.
   */
  async withText(pages: PageRow[], source: BookTextSource | null, bookId: string): Promise<PageRow[]> {
    if (!source || pages.length === 0) return pages;
    const byId = await source.pageText(
      bookId,
      pages.map((p) => p.page_id),
    );
    for (const page of pages) {
      const hit = byId.get(page.page_id);
      if (!hit) continue;
      page.text_original = htmlToText(hit.body);
      page.footnote = hit.foot ? htmlToText(hit.foot) : null;
    }
    return pages;
  }

  pageCount(): number {
    const row = this.db.get(
      `SELECT COUNT(*) AS n FROM ${quoteIdent(this.profile.pagesTable)}`,
    );
    return Number(row?.["n"] ?? 0);
  }

  pageById(pageId: number): PageRow | null {
    const p = this.profile;
    const row = this.db.get(
      `SELECT ${this.selectList()} FROM ${quoteIdent(p.pagesTable)} WHERE ${quoteIdent(p.pageId)} = ?`,
      pageId,
    );
    return row ? this.toPage(row) : null;
  }

  /**
   * Pages whose id sits in [from, to]. Used to pull the neighbours around a
   * hit so the reader sees the surrounding context.
   */
  pagesInRange(from: number, to: number): PageRow[] {
    const p = this.profile;
    const rows = this.db.all(
      `SELECT ${this.selectList()} FROM ${quoteIdent(p.pagesTable)}
        WHERE ${quoteIdent(p.pageId)} BETWEEN ? AND ?
        ORDER BY ${quoteIdent(p.pageId)} ASC`,
      from,
      to,
    );
    return rows.map((r) => this.toPage(r));
  }

  /**
   * Stream every page in id order, in batches, using keyset paging.
   * Never OFFSET: on a book with 50k pages a high offset re-walks the table
   * for each batch, and memory stays flat only if we hold one batch at a time.
   */
  *streamPages(batchSize = 500): Generator<PageRow, void, undefined> {
    const p = this.profile;
    const size = Math.max(1, Math.min(5000, batchSize));
    let after = Number.NEGATIVE_INFINITY;
    for (;;) {
      const rows = this.db.all(
        `SELECT ${this.selectList()} FROM ${quoteIdent(p.pagesTable)}
          WHERE ${quoteIdent(p.pageId)} > ?
          ORDER BY ${quoteIdent(p.pageId)} ASC
          LIMIT ?`,
        after === Number.NEGATIVE_INFINITY ? -1 : after,
        size,
      );
      if (rows.length === 0) return;
      for (const r of rows) {
        const page = this.toPage(r);
        after = page.page_id;
        yield page;
      }
      if (rows.length < size) return;
    }
  }

  /**
   * Table of contents entries, ordered by the page they point at.
   *
   * On Shamela 4 the heading text is not in this file — the `title` table holds
   * only ids, pages and parent links — so entries come back with an id and an
   * empty title, and `tocPathWithText` resolves the words from Lucene.
   */
  toc(): TocEntry[] {
    if (this.tocCache) return this.tocCache;
    const p = this.profile;
    if (!p.titlesTable || !p.titlePageRef) {
      this.tocCache = [];
      return this.tocCache;
    }
    const idCol = p.titleId ?? p.titlePageRef;
    const level = p.titleLevel ? `${quoteIdent(p.titleLevel)} AS lvl` : `1 AS lvl`;
    const titleExpr = p.titleText ? `${quoteIdent(p.titleText)} AS title` : `NULL AS title`;
    const rows = this.db.all(
      `SELECT ${quoteIdent(idCol)} AS title_id, ${quoteIdent(p.titlePageRef)} AS page_id, ${titleExpr}, ${level}
         FROM ${quoteIdent(p.titlesTable)}
        ORDER BY ${quoteIdent(p.titlePageRef)} ASC`,
    );
    this.tocCache = rows
      .map((r) => ({
        title_id: Number(r["title_id"]),
        page_id: Number(r["page_id"]),
        title: htmlToText(str(r["title"])),
        level: Number(r["lvl"] ?? 1) || 1,
      }))
      .filter((t) => Number.isFinite(t.page_id));
    return this.tocCache;
  }

  /**
   * Heading trail for a page, with the words resolved from Shamela's index.
   * Returns [] when the book has no table of contents — never a guessed name.
   */
  async tocPathWithText(pageId: number, source: BookTextSource | null, bookId: string): Promise<string[]> {
    const entries = this.toc();
    if (entries.length === 0) return [];

    const byLevel = new Map<number, TocEntry>();
    for (const e of entries) {
      if (e.page_id > pageId) break;
      byLevel.set(e.level, e);
      for (const lvl of [...byLevel.keys()]) if (lvl > e.level) byLevel.delete(lvl);
    }
    const trail = [...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([, e]) => e);
    if (trail.length === 0) return [];

    // Titles already carrying text (older layouts) need no lookup.
    const missing = trail.filter((e) => !e.title && Number.isFinite(e.title_id));
    if (missing.length > 0 && source) {
      const text = await source.titleText(
        bookId,
        missing.map((e) => e.title_id),
      );
      for (const e of missing) {
        const body = text.get(e.title_id);
        if (body) e.title = htmlToText(body);
      }
    }
    return trail.map((e) => e.title).filter((t) => t.length > 0);
  }

  /**
   * Heading trail for a page: the most recent heading at each level at or
   * before it. Returns [] when the book has no table of contents — we do not
   * invent a chapter name.
   */
  tocPath(pageId: number): string[] {
    const entries = this.toc();
    if (entries.length === 0) return [];
    const byLevel = new Map<number, string>();
    for (const e of entries) {
      if (e.page_id > pageId) break;
      byLevel.set(e.level, e.title);
      // A heading resets everything nested beneath it.
      for (const lvl of [...byLevel.keys()]) if (lvl > e.level) byLevel.delete(lvl);
    }
    return [...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  }
}

/** Open a book, converting a missing file into a typed, actionable error. */
export function openBookOrThrow(bookId: string, filePath: string | null): BookReader {
  if (!filePath) {
    throw new Fiqh4Error(
      "BOOK_NOT_DOWNLOADED",
      `الكتاب (${bookId}) غير مُنزَّل في المكتبة، فلا يمكن قراءة صفحاته. نزّله من داخل برنامج الشاملة ثم أعد المحاولة.`,
      `Book ${bookId} is listed in the catalogue but its database file is not present on disk.`,
      { book_id: bookId },
    );
  }
  return BookReader.open(filePath);
}
