import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { NORMALIZER_VERSION } from "../text/normalize.js";
import { defaultIndexDir } from "../util/paths.js";
import { Fiqh4Error } from "../util/errors.js";

/**
 * The derived search index. It lives in FIQH4_INDEX_DIR — never inside the
 * Shamela folder — and holds only what search needs: normalised text plus page
 * coordinates. It is disposable: deleting it costs a rebuild, nothing else.
 *
 * `text_search` is stored here and nowhere else. It is a lossy, folded form and
 * is never quoted back to the user; every quotation is re-read from the book's
 * own database as `text_original`.
 */

export const INDEX_SCHEMA_VERSION = 3;
export const INDEX_FILENAME = "fiqh4-index.db";

export function indexPath(dir?: string): string {
  return join(dir ?? defaultIndexDir(), INDEX_FILENAME);
}

export function openIndex(path: string, opts: { create: boolean }): DatabaseSync {
  if (opts.create) mkdirSync(dirname(path), { recursive: true });
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, opts.create ? {} : { readOnly: true });
  } catch (e) {
    throw new Fiqh4Error(
      "INDEX_MISSING",
      `تعذر فتح فهرس البحث في ${path}. أنشئه بتشغيل: npm run fiqh4:index`,
      `Cannot open search index at ${path}: ${(e as Error).message}`,
      { path },
    );
  }
  if (opts.create) initSchema(db);
  else assertSchema(db, path);
  return db;
}

function initSchema(db: DatabaseSync): void {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS indexed_books (
      book_id     TEXT PRIMARY KEY,
      page_count  INTEGER NOT NULL,
      indexed_at  TEXT    NOT NULL,
      source_size INTEGER,
      source_mtime INTEGER
    );
    CREATE TABLE IF NOT EXISTS pages (
      doc          INTEGER PRIMARY KEY,
      book_id      TEXT    NOT NULL,
      page_id      INTEGER NOT NULL,
      part         TEXT,
      printed_page INTEGER
    );
    CREATE INDEX IF NOT EXISTS pages_by_book ON pages(book_id, page_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      text_search,
      tokenize = 'unicode61 remove_diacritics 0'
    );
  `);

  const existing = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (!existing) {
    const set = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
    set.run("schema_version", String(INDEX_SCHEMA_VERSION));
    set.run("normalizer_version", NORMALIZER_VERSION);
    set.run("generation", "1");
    set.run("created_at", new Date().toISOString());
  }
}

function assertSchema(db: DatabaseSync, path: string): void {
  let row: { value: string } | undefined;
  try {
    row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
  } catch {
    row = undefined;
  }
  if (!row) {
    throw new Fiqh4Error(
      "INDEX_MISSING",
      `الفهرس في ${path} غير مهيأ. أعد بناءه: npm run fiqh4:index`,
      `Index at ${path} has no schema metadata.`,
      { path },
    );
  }
  if (Number(row.value) !== INDEX_SCHEMA_VERSION) {
    throw new Fiqh4Error(
      "INDEX_STALE",
      `إصدار مخطط الفهرس (${row.value}) لا يطابق الإصدار المطلوب (${INDEX_SCHEMA_VERSION}). أعد بناء الفهرس: npm run fiqh4:index`,
      `Index schema version ${row.value} != ${INDEX_SCHEMA_VERSION}.`,
      { path, found: row.value, expected: INDEX_SCHEMA_VERSION },
    );
  }
  const norm = db.prepare("SELECT value FROM meta WHERE key = 'normalizer_version'").get() as
    | { value: string }
    | undefined;
  if (norm && norm.value !== NORMALIZER_VERSION) {
    throw new Fiqh4Error(
      "INDEX_STALE",
      `الفهرس بُني بإصدار تطبيع مختلف (${norm.value}) عن الإصدار الحالي (${NORMALIZER_VERSION}). أعد بناء الفهرس: npm run fiqh4:index`,
      `Index normalizer ${norm.value} != ${NORMALIZER_VERSION}.`,
      { path, found: norm.value, expected: NORMALIZER_VERSION },
    );
  }
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)").run(key, value);
}
