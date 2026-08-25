import { openReadOnly, str, num, type ReadOnlyDb } from "./sqlite.js";
import { probeBook, quoteIdent, type BookProfile } from "./schemaProbe.js";
import { htmlToText } from "../text/html.js";
import { Fiqh4Error } from "../util/errors.js";

/**
 * Reads a single book database. Pages are streamed with keyset paging rather
 * than loaded wholesale — a large book has tens of thousands of pages and the
 * export sweep must run in roughly constant memory.
 */

export interface PageRow {
  page_id: number;
  /** Readable text exactly as the book has it. The only string ever quoted. */
  text_original: string;
  /** Volume / juz' as recorded by Shamela, or null when the column is absent. */
  part: string | null;
  /** Printed page number when Shamela records one, else null. Never guessed. */
  printed_page: number | null;
}

export interface TocEntry {
  title_id: number;
  page_id: number;
  title: string;
  level: number;
  parent_id: number | null;
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
      text_original: htmlToText(r["body"] as string | null),
      part: str(r["part"]),
      printed_page: num(r["printed_page"]),
    };
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

  /** Table of contents entries, ordered by the page they point at. */
  toc(): TocEntry[] {
    if (this.tocCache) return this.tocCache;
    const p = this.profile;
    if (!p.titlesTable || !p.titleId) {
      this.tocCache = [];
      return this.tocCache;
    }
    const pageRef = p.titlePageRef ?? p.titleId;
    const parent = p.titleParent ? `${quoteIdent(p.titleParent)} AS parent_id` : `NULL AS parent_id`;
    const title = p.titleText ? `${quoteIdent(p.titleText)} AS title` : `NULL AS title`;
    const level = p.titleLevel ? `${quoteIdent(p.titleLevel)} AS lvl` : `1 AS lvl`;
    const rows = this.db.all(
      `SELECT ${quoteIdent(p.titleId)} AS title_id, ${quoteIdent(pageRef)} AS page_id, ${title}, ${parent}, ${level}
         FROM ${quoteIdent(p.titlesTable)}
        ORDER BY ${quoteIdent(pageRef)} ASC, ${quoteIdent(p.titleId)} ASC`,
    );
    this.tocCache = rows
      .map((r) => ({
        title_id: Number(r["title_id"]),
        page_id: Number(r["page_id"]),
        title: htmlToText(str(r["title"])),
        level: Number(r["lvl"] ?? 1) || 1,
        parent_id: num(r["parent_id"]),
      }))
      .filter((t) => Number.isFinite(t.page_id) && Number.isFinite(t.title_id));
    return this.tocCache;
  }

  tocTrail(pageId: number): TocEntry[] {
    const entries = this.toc();
    if (entries.length === 0) return [];

    const withParents = entries.some((e) => e.parent_id !== null);
    if (withParents) {
      const before = entries.filter((e) => e.page_id <= pageId);
      const current = before[before.length - 1];
      if (!current) return [];
      const byId = new Map(entries.map((e) => [e.title_id, e]));
      const out: TocEntry[] = [];
      const seen = new Set<number>();
      let cur: TocEntry | undefined = current;
      for (let depth = 0; cur && depth < 12; depth++) {
        if (seen.has(cur.title_id)) break;
        seen.add(cur.title_id);
        out.push(cur);
        cur = cur.parent_id === null ? undefined : byId.get(cur.parent_id);
      }
      return out.reverse();
    }

    const byLevel = new Map<number, TocEntry>();
    for (const e of entries) {
      if (e.page_id > pageId) break;
      byLevel.set(e.level, e);
      for (const lvl of [...byLevel.keys()]) if (lvl > e.level) byLevel.delete(lvl);
    }
    return [...byLevel.entries()].sort((a, b) => a[0] - b[0]).map(([, t]) => t);
  }

  /**
   * Heading trail for a page: the most recent heading at each level at or
   * before it. Returns [] when the book has no table of contents — we do not
   * invent a chapter name.
   */
  tocPath(pageId: number, titleTexts: Map<number, string> = new Map()): string[] {
    return this.tocTrail(pageId)
      .map((e) => titleTexts.get(e.title_id) ?? e.title)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
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
