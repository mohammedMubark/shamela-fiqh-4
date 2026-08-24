import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { NORMALIZER_VERSION } from "../text/normalize.js";
import { Fiqh4Error } from "../util/errors.js";
import { isFile } from "../util/paths.js";
import {
  INDEX_SCHEMA_VERSION,
  getMeta,
  indexPath,
  openIndex,
} from "./indexDb.js";
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
 * Default engine: SQLite FTS5 over the derived index.
 *
 * Paging is keyset, not OFFSET. Ordering is (score DESC, doc ASC); the doc id
 * breaks score ties so the order is total and a page boundary can never drop or
 * repeat a hit. Resuming asks for "strictly worse than the last hit", which
 * costs the same whether it is page 2 or page 2000 — an OFFSET of 50,000 would
 * re-walk every earlier match on every request.
 */
export class NodeSearchEngine implements SearchEngine {
  readonly id = "node-fts5" as const;
  private readonly db: DatabaseSync;
  private readonly path: string;
  private fingerprintCache = new Map<string, string>();

  private constructor(db: DatabaseSync, path: string) {
    this.db = db;
    this.path = path;
  }

  static open(indexDir?: string): NodeSearchEngine {
    const path = indexPath(indexDir);
    if (!isFile(path)) {
      throw new Fiqh4Error(
        "INDEX_MISSING",
        `لا يوجد فهرس بحث بعد في ${path}. ابنِه أولًا بتشغيل: npm run fiqh4:index`,
        `No search index at ${path}. Build it with: npm run fiqh4:index`,
        { index_path: path },
      );
    }
    return new NodeSearchEngine(openIndex(path, { create: false }), path);
  }

  static exists(indexDir?: string): boolean {
    return isFile(indexPath(indexDir));
  }

  get indexPathValue(): string {
    return this.path;
  }

  /**
   * Identity of the data this engine will search.
   *
   * Includes the index generation and each in-scope book's own indexed_at, so
   * reindexing any selected book — not just a full rebuild — invalidates every
   * cursor issued before it.
   */
  fingerprint(scopeBookIds: string[]): string {
    const key = scopeBookIds.length === 0 ? "*" : [...scopeBookIds].sort().join(",");
    const cached = this.fingerprintCache.get(key);
    if (cached) return cached;

    const generation = getMeta(this.db, "generation") ?? "0";
    const stamps =
      scopeBookIds.length === 0
        ? (this.db
            .prepare("SELECT book_id, indexed_at FROM indexed_books ORDER BY book_id")
            .all() as Array<{ book_id: string; indexed_at: string }>)
        : (this.db
            .prepare(
              `SELECT book_id, indexed_at FROM indexed_books
                WHERE book_id IN (SELECT value FROM json_each(?))
                ORDER BY book_id`,
            )
            .all(JSON.stringify(scopeBookIds)) as Array<{ book_id: string; indexed_at: string }>);

    const fp = createHash("sha256")
      .update(
        JSON.stringify({
          engine: this.id,
          schema: INDEX_SCHEMA_VERSION,
          normalizer: NORMALIZER_VERSION,
          generation,
          books: stamps.map((s) => `${s.book_id}@${s.indexed_at}`),
        }),
      )
      .digest("hex")
      .slice(0, 24);

    this.fingerprintCache.set(key, fp);
    return fp;
  }

  indexedBooks(): IndexedBookInfo[] {
    return this.db
      .prepare("SELECT book_id, page_count, indexed_at FROM indexed_books ORDER BY book_id")
      .all() as unknown as IndexedBookInfo[];
  }

  isIndexed(bookId: string): boolean {
    const row = this.db.prepare("SELECT 1 AS x FROM indexed_books WHERE book_id = ?").get(bookId);
    return row !== undefined;
  }

  async search(req: EngineSearchRequest): Promise<EngineSearchResult> {
    const scoped = req.bookIds.length > 0;
    const scopeJson = scoped ? JSON.stringify(req.bookIds) : null;
    const scopeClause = scoped ? "AND p.book_id IN (SELECT value FROM json_each(?))" : "";

    // Exact total — never an estimate. Skipped when the caller already has it
    // from a cursor, because counting rescans the whole match set and that cost
    // otherwise repeats on every batch.
    let totalHits = -1;
    if (req.withTotal !== false) {
      const countSql = `
        SELECT COUNT(*) AS n
          FROM pages_fts f
          JOIN pages p ON p.doc = f.rowid
         WHERE f.pages_fts MATCH ? ${scopeClause}`;
      const countParams: unknown[] = scoped
        ? [req.query.ftsExpression, scopeJson]
        : [req.query.ftsExpression];
      totalHits = Number(
        (this.db.prepare(countSql).get(...(countParams as never[])) as { n: number }).n,
      );
    }

    const after = req.after;
    const byDoc = req.orderBy === "doc";

    // Keyset predicate: strictly after the last row in the chosen total order.
    // Ordering by doc alone lets SQLite seek to the resume point and stop at
    // LIMIT; ordering by score has to consider every match to rank them.
    const keysetClause = after
      ? byDoc
        ? "AND h.doc > ?"
        : "AND (h.score < ? OR (h.score = ? AND h.doc > ?))"
      : "";

    const sql = `
      WITH h AS (
        SELECT f.rowid AS doc, ${byDoc ? "0.0" : "-bm25(pages_fts)"} AS score
          FROM pages_fts f
         WHERE f.pages_fts MATCH ?
      )
      SELECT p.book_id, p.page_id, p.part, p.printed_page, h.doc, h.score
        FROM h
        JOIN pages p ON p.doc = h.doc
       WHERE 1 = 1 ${scopeClause} ${keysetClause}
       ORDER BY ${byDoc ? "h.doc ASC" : "h.score DESC, h.doc ASC"}
       LIMIT ?`;

    const params: unknown[] = [req.query.ftsExpression];
    if (scoped) params.push(scopeJson);
    if (after) {
      if (byDoc) params.push(after.doc);
      else params.push(after.score, after.score, after.doc);
    }
    // Fetch one extra row to learn whether more exist without a second query.
    params.push(req.limit + 1);

    const rows = this.db.prepare(sql).all(...(params as never[])) as Array<{
      book_id: string;
      page_id: number;
      part: string | null;
      printed_page: number | null;
      doc: number;
      score: number;
    }>;

    const hasMore = rows.length > req.limit;
    const page = hasMore ? rows.slice(0, req.limit) : rows;

    const hits: EngineHit[] = page.map((r) => ({
      book_id: String(r.book_id),
      page_id: Number(r.page_id),
      score: Number(r.score),
      doc: Number(r.doc),
      part: r.part === null || r.part === undefined ? null : String(r.part),
      printed_page:
        r.printed_page === null || r.printed_page === undefined ? null : Number(r.printed_page),
    }));

    const last = hits[hits.length - 1];
    return {
      hits,
      totalHits,
      hasMore,
      after: hasMore && last ? { score: last.score, doc: last.doc } : null,
    };
  }

  async countsByBook(query: ParsedQuery, bookIds: string[]): Promise<BookHitCount[]> {
    const scoped = bookIds.length > 0;
    const sql = `
      SELECT p.book_id AS book_id, COUNT(*) AS hits
        FROM pages_fts f
        JOIN pages p ON p.doc = f.rowid
       WHERE f.pages_fts MATCH ? ${scoped ? "AND p.book_id IN (SELECT value FROM json_each(?))" : ""}
       GROUP BY p.book_id
       ORDER BY hits DESC, p.book_id ASC`;
    const params: unknown[] = scoped
      ? [query.ftsExpression, JSON.stringify(bookIds)]
      : [query.ftsExpression];
    const rows = this.db.prepare(sql).all(...(params as never[])) as Array<{
      book_id: string;
      hits: number;
    }>;
    return rows.map((r) => ({ book_id: String(r.book_id), hits: Number(r.hits) }));
  }

  async pageIdsForBook(query: ParsedQuery, bookId: string, limit: number): Promise<number[]> {
    const rows = this.db
      .prepare(
        `SELECT p.page_id AS page_id
           FROM pages_fts f
           JOIN pages p ON p.doc = f.rowid
          WHERE f.pages_fts MATCH ? AND p.book_id = ?
          ORDER BY p.page_id ASC
          LIMIT ?`,
      )
      .all(query.ftsExpression, bookId, Math.max(1, limit)) as Array<{ page_id: number }>;
    return rows.map((r) => Number(r.page_id));
  }

  /** Normalised indexed text for a page — used for match reasons only, never quoted. */
  searchTextFor(bookId: string, pageId: number): string | null {
    const row = this.db
      .prepare(
        `SELECT f.text_search AS t
           FROM pages p JOIN pages_fts f ON f.rowid = p.doc
          WHERE p.book_id = ? AND p.page_id = ?`,
      )
      .get(bookId, pageId) as { t: string } | undefined;
    return row?.t ?? null;
  }

  stats(): { books: number; pages: number; generation: string; updated_at: string | null } {
    const books = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM indexed_books").get() as { n: number }).n,
    );
    const pages = Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM pages").get() as { n: number }).n,
    );
    return {
      books,
      pages,
      generation: getMeta(this.db, "generation") ?? "0",
      updated_at: getMeta(this.db, "updated_at"),
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
