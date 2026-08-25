import { DatabaseSync } from "node:sqlite";
import { Fiqh4Error } from "../util/errors.js";
import { isFile } from "../util/paths.js";

/**
 * Every Shamela file is opened through this module and only through it.
 * `readOnly: true` makes SQLite reject writes at the engine level, so a bug in
 * a query cannot mutate the user's library.
 */

export type Row = Record<string, unknown>;

export interface ReadOnlyDb {
  readonly path: string;
  all(sql: string, ...params: unknown[]): Row[];
  get(sql: string, ...params: unknown[]): Row | undefined;
  iterate(sql: string, ...params: unknown[]): IterableIterator<Row>;
  close(): void;
}

export function openReadOnly(path: string): ReadOnlyDb {
  if (!isFile(path)) {
    throw new Fiqh4Error(
      "BOOK_UNREADABLE",
      `تعذر العثور على ملف قاعدة البيانات: ${path}`,
      `SQLite file not found: ${path}`,
      { path },
    );
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    throw new Fiqh4Error(
      "BOOK_UNREADABLE",
      `تعذر فتح قاعدة البيانات للقراءة: ${path}`,
      `Cannot open SQLite database read-only: ${path} (${(e as Error).message})`,
      { path },
    );
  }

  return {
    path,
    all(sql, ...params) {
      return db.prepare(sql).all(...(params as never[])) as Row[];
    },
    get(sql, ...params) {
      return db.prepare(sql).get(...(params as never[])) as Row | undefined;
    },
    *iterate(sql, ...params) {
      // node:sqlite has no cursor API, so we page with keyset-free LIMIT/OFFSET
      // only where the caller has already bounded the statement. Callers that
      // stream large tables use `iterateKeyset` in bookRepo instead.
      const rows = db.prepare(sql).all(...(params as never[])) as Row[];
      for (const r of rows) yield r;
    },
    close() {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
