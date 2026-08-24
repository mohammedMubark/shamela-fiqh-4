import { statSync } from "node:fs";
import { normalizeArabic } from "../text/normalize.js";
import { BookReader } from "../shamela/bookRepo.js";
import type { ClassifiedBook } from "../classify/types.js";
import { log } from "../util/log.js";
import { getMeta, indexPath, openIndex, setMeta } from "./indexDb.js";

/**
 * Builds the derived index, one book at a time.
 *
 * Pages are streamed and inserted inside a per-book transaction, so peak memory
 * is one batch regardless of corpus size, and an interrupted run leaves whole
 * books either indexed or not — never half.
 */

export interface IndexProgress {
  book_id: string;
  title: string | null;
  pages: number;
  skipped: boolean;
  error?: string;
}

export interface IndexSummary {
  index_path: string;
  generation: number;
  books_indexed: number;
  books_skipped: number;
  books_failed: Array<{ book_id: string; error: string }>;
  pages_indexed: number;
  elapsed_ms: number;
}

export interface IndexOptions {
  indexDir?: string;
  /** Rebuild books even when the source file looks unchanged. */
  force?: boolean;
  onProgress?: (p: IndexProgress) => void;
}

function sourceStamp(path: string): { size: number; mtime: number } {
  try {
    const s = statSync(path);
    return { size: s.size, mtime: Math.floor(s.mtimeMs) };
  } catch {
    return { size: -1, mtime: -1 };
  }
}

export function buildIndex(books: readonly ClassifiedBook[], opts: IndexOptions = {}): IndexSummary {
  const started = Date.now();
  const path = indexPath(opts.indexDir);
  const db = openIndex(path, { create: true });

  const summary: IndexSummary = {
    index_path: path,
    generation: 0,
    books_indexed: 0,
    books_skipped: 0,
    books_failed: [],
    pages_indexed: 0,
    elapsed_ms: 0,
  };

  const selectStamp = db.prepare(
    "SELECT source_size, source_mtime FROM indexed_books WHERE book_id = ?",
  );
  const deletePagesFts = db.prepare(
    "DELETE FROM pages_fts WHERE rowid IN (SELECT doc FROM pages WHERE book_id = ?)",
  );
  const deletePages = db.prepare("DELETE FROM pages WHERE book_id = ?");
  const insertPage = db.prepare(
    "INSERT INTO pages(book_id, page_id, part, printed_page) VALUES (?, ?, ?, ?)",
  );
  const insertFts = db.prepare("INSERT INTO pages_fts(rowid, text_search) VALUES (?, ?)");
  const upsertBook = db.prepare(
    `INSERT INTO indexed_books(book_id, page_count, indexed_at, source_size, source_mtime)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(book_id) DO UPDATE SET
       page_count = excluded.page_count,
       indexed_at = excluded.indexed_at,
       source_size = excluded.source_size,
       source_mtime = excluded.source_mtime`,
  );

  try {
    for (const book of books) {
      if (!book.downloaded || !book.file_path) {
        summary.books_skipped++;
        opts.onProgress?.({ book_id: book.book_id, title: book.title, pages: 0, skipped: true });
        continue;
      }

      const stamp = sourceStamp(book.file_path);
      if (!opts.force) {
        const prev = selectStamp.get(book.book_id) as
          | { source_size: number; source_mtime: number }
          | undefined;
        if (prev && prev.source_size === stamp.size && prev.source_mtime === stamp.mtime) {
          summary.books_skipped++;
          opts.onProgress?.({ book_id: book.book_id, title: book.title, pages: 0, skipped: true });
          continue;
        }
      }

      let reader: BookReader | null = null;
      try {
        reader = BookReader.open(book.file_path);
        db.exec("BEGIN");
        deletePagesFts.run(book.book_id);
        deletePages.run(book.book_id);

        let pages = 0;
        for (const page of reader.streamPages(500)) {
          const searchText = normalizeArabic(page.text_original);
          if (searchText.length === 0) continue;
          const res = insertPage.run(
            book.book_id,
            page.page_id,
            page.part,
            page.printed_page,
          );
          insertFts.run(Number(res.lastInsertRowid), searchText);
          pages++;
        }

        upsertBook.run(book.book_id, pages, new Date().toISOString(), stamp.size, stamp.mtime);
        db.exec("COMMIT");

        summary.books_indexed++;
        summary.pages_indexed += pages;
        opts.onProgress?.({ book_id: book.book_id, title: book.title, pages, skipped: false });
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* no transaction open */
        }
        const message = e instanceof Error ? e.message : String(e);
        summary.books_failed.push({ book_id: book.book_id, error: message });
        log.warn("failed to index book", { book_id: book.book_id, error: message });
        opts.onProgress?.({
          book_id: book.book_id,
          title: book.title,
          pages: 0,
          skipped: false,
          error: message,
        });
      } finally {
        reader?.close();
      }
    }

    // A new generation invalidates every previously issued cursor, which is the
    // point: results from before a rebuild must not be resumed after it.
    const generation = Number(getMeta(db, "generation") ?? "1") + 1;
    setMeta(db, "generation", String(generation));
    setMeta(db, "updated_at", new Date().toISOString());
    summary.generation = generation;
  } finally {
    db.close();
  }

  summary.elapsed_ms = Date.now() - started;
  return summary;
}
