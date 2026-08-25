import type { ReadOnlyDb, Row } from "./sqlite.js";
import { Fiqh4Error } from "../util/errors.js";

/**
 * Shamela's schema is discovered at runtime, never assumed.
 *
 * Different Shamela 4 builds (and repacked libraries) rename tables and columns,
 * and category IDs are explicitly not stable across installations. So instead of
 * hardcoding `book.nass`, we read `sqlite_master`, score every table against a
 * set of column aliases, and report what we found. A library we cannot read
 * produces a diagnostic in `fiqh4_health` rather than a stack trace mid-search.
 */

export interface TableInfo {
  name: string;
  columns: string[];
}

/**
 * Column aliases per ROLE, most-specific first. Matching is case-insensitive.
 *
 * Roles are kept separate on purpose. An earlier version reused the book-id
 * list to find the category table's primary key, which silently failed on a
 * library whose key is `category_id` — and a failed lookup here does not throw,
 * it just leaves every book unclassified. Each lookup now has its own list.
 *
 * Two Shamela generations are covered:
 *   older builds:  bkid, bk, cat, authno, nass
 *   newer builds:  book_id, book_name, book_category, main_author, category_name
 */
const ALIASES = {
  bookId: ["book_id", "bkid", "bookid", "bid", "id"],
  bookTitle: ["book_name", "bk", "title", "bookname", "name", "tit"],
  bookInfo: ["betaka", "meta_data", "info", "descr", "description", "nbal"],

  /** Column on the BOOK row pointing at an author. */
  bookAuthorRef: ["main_author", "author_id", "authno", "auth_id", "authid"],
  /** Primary key of the authors table. */
  authorPk: ["author_id", "authno", "auth_id", "authid", "id"],
  authorName: ["author_name", "auth", "author", "authname"],

  /** Column on the BOOK row pointing at a category. */
  bookCategoryRef: ["book_category", "category_id", "cat_id", "catid", "cat", "category"],
  /** Primary key of the categories table. */
  categoryPk: ["category_id", "cat_id", "catid", "id"],
  categoryName: ["category_name", "cat_name", "catname", "name", "title"],

  pageId: ["id", "pageid", "page_id", "pgid"],
  pageText: ["nass", "text", "content", "body", "matn", "nas"],
  pagePart: ["part", "juz", "vol", "volume", "jozz"],
  pagePrinted: ["page", "pg", "printed_page", "safha", "sfha"],
  titleText: ["tit", "title", "name", "heading"],
  titleLevel: ["lvl", "level", "depth", "sub"],
} as const;

function pick(columns: string[], aliases: readonly string[]): string | null {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  for (const a of aliases) {
    const hit = lower.get(a);
    if (hit) return hit;
  }
  return null;
}

/** Pick an alias, but refuse a column already taken by another role. */
function pickExcluding(
  columns: string[],
  aliases: readonly string[],
  taken: readonly (string | null)[],
): string | null {
  const busy = new Set(taken.filter(Boolean).map((c) => (c as string).toLowerCase()));
  return pick(
    columns.filter((c) => !busy.has(c.toLowerCase())),
    aliases,
  );
}

export function listTables(db: ReadOnlyDb): TableInfo[] {
  const rows = db.all(
    "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((r) => {
    const name = String(r["name"]);
    const cols = db.all(`PRAGMA table_info(${quoteIdent(name)})`) as Row[];
    return { name, columns: cols.map((c) => String(c["name"])) };
  });
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

// ── master.db ───────────────────────────────────────────────────────────────

export interface MasterProfile {
  booksTable: string;
  bookId: string;
  bookTitle: string;
  bookAuthorName: string | null;
  bookAuthorId: string | null;
  bookCategoryId: string | null;
  categoriesTable: string | null;
  categoryId: string | null;
  categoryName: string | null;
  authorsTable: string | null;
  authorId: string | null;
  authorName: string | null;
  /** Every table we saw — surfaced in health so a mismatch is debuggable. */
  tables: TableInfo[];
  notes: string[];
}

export function probeMaster(db: ReadOnlyDb): MasterProfile {
  const tables = listTables(db);
  const notes: string[] = [];

  // The books table is the one with both an id-ish and a title-ish column and
  // the most rows; prefer a table literally named `book`/`books`.
  const candidates = tables
    .map((t) => {
      const id = pick(t.columns, ALIASES.bookId);
      const title = pickExcluding(t.columns, ALIASES.bookTitle, [id]);
      if (!id || !title) return null;
      let score = 0;
      if (/^books?$/i.test(t.name)) score += 10;
      if (pick(t.columns, ALIASES.bookCategoryRef)) score += 3;
      if (pick(t.columns, ALIASES.authorName) || pick(t.columns, ALIASES.bookAuthorRef)) score += 3;
      if (t.columns.length >= 4) score += 1;
      return { t, id, title, score };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) {
    throw new Fiqh4Error(
      "SCHEMA_UNRECOGNISED",
      "تعذر التعرف على بنية master.db: لم يُعثر على جدول كتب يحتوي على معرّف وعنوان.",
      "Could not identify a books table (needs an id-like and a title-like column) in master.db.",
      { tables: tables.map((t) => `${t.name}(${t.columns.join(",")})`) },
    );
  }
  if (candidates.length > 1) {
    notes.push(
      `عُثر على ${candidates.length} جداول مرشّحة للكتب؛ اختير «${best.t.name}» بأعلى درجة تطابق.`,
    );
  }

  const catTable =
    tables.find((t) => /^(cat|cats|categories|category)$/i.test(t.name)) ??
    tables.find((t) => t !== best.t && pick(t.columns, ALIASES.categoryName) !== null && t.columns.length <= 4) ??
    null;
  const catId = catTable ? pick(catTable.columns, ALIASES.categoryPk) : null;
  const catName = catTable ? pickExcluding(catTable.columns, ALIASES.categoryName, [catId]) : null;
  if (!catTable) notes.push("لم يُعثر على جدول فئات مستقل؛ سيُعتمد على عمود الفئة داخل جدول الكتب إن وُجد.");
  else if (!catId || !catName) {
    notes.push(
      `عُثر على جدول الفئات «${catTable.name}» لكن تعذّر تحديد ${!catId ? "عمود المعرّف" : "عمود الاسم"} فيه. ` +
        `أعمدته: ${catTable.columns.join("، ")}. لن تُقرأ أسماء الفئات، فلن يُصنَّف أي كتاب.`,
    );
  }

  const authTable =
    tables.find((t) => /^(auth|authors|author)$/i.test(t.name)) ?? null;
  const authId = authTable ? pick(authTable.columns, ALIASES.authorPk) : null;
  const authName = authTable ? pickExcluding(authTable.columns, ALIASES.authorName, [authId]) : null;

  const bookAuthorId = pickExcluding(best.t.columns, ALIASES.bookAuthorRef, [best.id, best.title]);
  const bookAuthorName = pickExcluding(best.t.columns, ALIASES.authorName, [
    best.id,
    best.title,
    bookAuthorId,
  ]);
  const bookCategoryId = pickExcluding(best.t.columns, ALIASES.bookCategoryRef, [
    best.id,
    best.title,
    bookAuthorId,
    bookAuthorName,
  ]);

  if (!bookCategoryId) {
    notes.push(
      "لم يُعثر على عمود فئة في جدول الكتب، فلن يُصنَّف أي كتاب حسب المذهب. " +
        `الأعمدة الموجودة فعلًا: ${best.t.columns.join("، ")}. ` +
        "شغّل npm run fiqh4:schema وأبلغ عن هذه القائمة ليُضاف الاسم المناسب.",
    );
  }

  return {
    booksTable: best.t.name,
    bookId: best.id,
    bookTitle: best.title,
    bookAuthorName,
    bookAuthorId,
    bookCategoryId,
    categoriesTable: catTable?.name ?? null,
    categoryId: catId,
    categoryName: catName,
    authorsTable: authTable?.name ?? null,
    authorId: authId,
    authorName: authName,
    tables,
    notes,
  };
}

// ── individual book databases ───────────────────────────────────────────────

export interface BookProfile {
  pagesTable: string;
  pageId: string;
  /** Null on Shamela 4: page text lives in Lucene, not in this file. */
  pageText: string | null;
  pagePart: string | null;
  pagePrinted: string | null;
  titlesTable: string | null;
  /** Row id of a heading — the key its text is stored under in Lucene. */
  titleId: string | null;
  titlePageRef: string | null;
  titleText: string | null;
  titleLevel: string | null;
  tables: TableInfo[];
  notes: string[];
}

export function probeBook(db: ReadOnlyDb): BookProfile {
  const tables = listTables(db);
  const notes: string[] = [];

  // A book's SQLite file carries pagination and the heading tree; the text of
  // both pages and headings lives in Shamela's Lucene indexes. So a text column
  // is optional here — requiring one rejected every real library.
  const candidates = tables
    .map((t) => {
      const id = pick(t.columns, ALIASES.pageId);
      if (!id) return null;
      const text = pickExcluding(t.columns, ALIASES.pageText, [id]);
      let score = 0;
      if (/^(page|pages|book|content)$/i.test(t.name)) score += 10;
      if (text) score += 4;
      if (pickExcluding(t.columns, ALIASES.pagePart, [id, text])) score += 2;
      if (pickExcluding(t.columns, ALIASES.pagePrinted, [id, text])) score += 2;
      return { t, id, text, score };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) {
    throw new Fiqh4Error(
      "SCHEMA_UNRECOGNISED",
      "تعذر التعرف على بنية قاعدة بيانات الكتاب: لم يُعثر على جدول صفحات.",
      "Could not identify a pages table in the book database.",
      { tables: tables.map((t) => `${t.name}(${t.columns.join(",")})`) },
    );
  }
  if (!best.text) {
    notes.push("لا يوجد عمود نص في جدول الصفحات — وهذا هو المتوقع في الشاملة 4؛ النص يُقرأ من فهرس Lucene.");
  }

  const part = pickExcluding(best.t.columns, ALIASES.pagePart, [best.id, best.text]);
  const printed = pickExcluding(best.t.columns, ALIASES.pagePrinted, [best.id, best.text, part]);
  if (!printed) notes.push("لا يوجد عمود للصفحة المطبوعة؛ ستُعاد القيمة null بدل تخمينها.");
  if (!part) notes.push("لا يوجد عمود للجزء؛ ستُعاد القيمة null بدل تخمينها.");

  const titleTable =
    tables.find((t) => /^(title|titles|toc|fahras)$/i.test(t.name)) ??
    tables.find((t) => t !== best.t && pick(t.columns, ALIASES.titleText) !== null) ??
    null;
  // On Shamela 4 the title table is (id, page, parent): `id` identifies the
  // heading and `page` says where it starts, so they must not be confused.
  const titleIdCol = titleTable ? pick(titleTable.columns, ["id", "title_id", "tid"]) : null;
  const titleRef = titleTable
    ? (pick(titleTable.columns, ["page", "page_id", "pageid"]) ?? titleIdCol)
    : null;
  const titleTxt = titleTable
    ? pickExcluding(titleTable.columns, ALIASES.titleText, [titleRef])
    : null;
  const titleLvl = titleTable
    ? pickExcluding(titleTable.columns, ALIASES.titleLevel, [titleRef, titleTxt])
    : null;
  if (!titleTable) notes.push("لا يوجد جدول فهرس؛ سيكون مسار العنوان فارغًا.");

  return {
    pagesTable: best.t.name,
    pageId: best.id,
    pageText: best.text,
    pagePart: part,
    pagePrinted: printed,
    titlesTable: titleTable?.name ?? null,
    titleId: titleIdCol,
    titlePageRef: titleRef,
    titleText: titleTxt,
    titleLevel: titleLvl,
    tables,
    notes,
  };
}
