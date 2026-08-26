import { afterAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReadOnly } from "../../src/shamela/sqlite.js";
import { probeBook, probeMaster } from "../../src/shamela/schemaProbe.js";
import { Fiqh4Error } from "../../src/util/errors.js";

/**
 * The probe must recognise more than one Shamela generation.
 *
 * These fixtures are not invented: the "modern" column names below are the ones
 * a real 8,598-book library reported, where an earlier version of the probe
 * found no category column at all and silently left every book unclassified.
 * A failure that quiet is worth a test per schema shape.
 */

const dir = mkdtempSync(join(tmpdir(), "fiqh4-probe-"));

/**
 * Every handle opened here is closed before the directory is removed: Windows
 * refuses to unlink a file SQLite still holds open, so a leaked handle turns
 * cleanup into an EBUSY failure that has nothing to do with what is asserted.
 */
const opened: { close(): void }[] = [];
function open(path: string) {
  const db = openReadOnly(path);
  opened.push(db);
  return db;
}

afterAll(() => {
  for (const db of opened.splice(0)) db.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeDb(name: string, ddl: string): string {
  const path = join(dir, `${name}.db`);
  const db = new DatabaseSync(path);
  db.exec(ddl);
  db.close();
  return path;
}

describe("probeMaster — modern Shamela schema", () => {
  // Exactly the tables and columns reported by the real library.
  const path = makeDb(
    "modern-master",
    `
    CREATE TABLE author (author_id INTEGER PRIMARY KEY, author_name TEXT, death_number INT, death_text TEXT, alpha TEXT);
    CREATE TABLE author_book (author_id INTEGER, book_id INTEGER);
    CREATE TABLE book (
      book_id INTEGER PRIMARY KEY, book_name TEXT, book_category INTEGER, book_type INT,
      book_date INT, authors TEXT, main_author INTEGER, printed INT, group_id INT, hidden INT,
      major_online INT, minor_online INT, major_ondisk INT, minor_ondisk INT, pdf_links TEXT,
      pdf_ondisk INT, pdf_online INT, cover_ondisk INT, cover_online INT, meta_data TEXT,
      parent INT, alpha TEXT, group_order INT, book_up INT
    );
    CREATE TABLE category (category_id INTEGER PRIMARY KEY, category_name TEXT, category_order INT);
    CREATE TABLE coauthor_book (author_id INTEGER, book_id INTEGER);
    CREATE TABLE db_ver (value TEXT);
    CREATE TABLE version (key TEXT, value TEXT);
  `,
  );

  const profile = probeMaster(open(path));

  it("finds the books table and its identity columns", () => {
    expect(profile.booksTable).toBe("book");
    expect(profile.bookId).toBe("book_id");
    expect(profile.bookTitle).toBe("book_name");
  });

  it("finds the category link on the book row", () => {
    // This is the one that failed in the field: without it nothing classifies.
    expect(profile.bookCategoryId).toBe("book_category");
  });

  it("finds the categories table and BOTH its key and name columns", () => {
    expect(profile.categoriesTable).toBe("category");
    expect(profile.categoryId).toBe("category_id");
    expect(profile.categoryName).toBe("category_name");
  });

  it("resolves the author through the join, not by guessing", () => {
    expect(profile.authorsTable).toBe("author");
    expect(profile.authorId).toBe("author_id");
    expect(profile.authorName).toBe("author_name");
    expect(profile.bookAuthorId).toBe("main_author");
  });

  it("does not mistake book_name or book_type for the category", () => {
    expect(profile.bookCategoryId).not.toBe("book_type");
    expect(profile.bookTitle).not.toBe("book_type");
  });
});

describe("probeMaster — older Shamela schema", () => {
  const path = makeDb(
    "legacy-master",
    `
    CREATE TABLE book (bkid INTEGER PRIMARY KEY, bk TEXT, cat INTEGER, authno INTEGER, betaka TEXT);
    CREATE TABLE cat (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE auth (authno INTEGER PRIMARY KEY, auth TEXT);
  `,
  );
  const profile = probeMaster(open(path));

  it("still recognises the legacy column names", () => {
    expect(profile.booksTable).toBe("book");
    expect(profile.bookId).toBe("bkid");
    expect(profile.bookTitle).toBe("bk");
    expect(profile.bookCategoryId).toBe("cat");
    expect(profile.categoriesTable).toBe("cat");
    expect(profile.categoryId).toBe("id");
    expect(profile.categoryName).toBe("name");
    expect(profile.authorsTable).toBe("auth");
    expect(profile.authorId).toBe("authno");
  });
});

describe("probeMaster — reporting when it cannot resolve", () => {
  it("says loudly that no category column means nothing will classify", () => {
    const path = makeDb(
      "no-category",
      `CREATE TABLE book (book_id INTEGER PRIMARY KEY, book_name TEXT, book_date INT);`,
    );
    const profile = probeMaster(open(path));
    expect(profile.bookCategoryId).toBeNull();
    const notes = profile.notes.join(" ");
    expect(notes).toContain("لن يُصنَّف أي كتاب");
    // The note must name the real columns, so a report is actionable.
    expect(notes).toContain("book_date");
  });

  it("throws with the table list when there is no books table at all", () => {
    const path = makeDb("nonsense", `CREATE TABLE unrelated (a INT, b INT);`);
    try {
      probeMaster(open(path));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Fiqh4Error);
      expect((e as Fiqh4Error).code).toBe("SCHEMA_UNRECOGNISED");
      expect(JSON.stringify((e as Fiqh4Error).details)).toContain("unrelated");
    }
  });
});

describe("probeBook", () => {
  it("recognises the legacy book layout", () => {
    const path = makeDb(
      "legacy-book",
      `CREATE TABLE book (id INTEGER PRIMARY KEY, page INTEGER, part TEXT, nass TEXT);
       CREATE TABLE title (id INTEGER, tit TEXT, lvl INTEGER);`,
    );
    const p = probeBook(open(path));
    expect(p.pagesTable).toBe("book");
    expect(p.pageText).toBe("nass");
    expect(p.pagePart).toBe("part");
    expect(p.pagePrinted).toBe("page");
    expect(p.titlesTable).toBe("title");
  });

  it("recognises a page table using 'content'", () => {
    const path = makeDb(
      "content-book",
      `CREATE TABLE page (id INTEGER PRIMARY KEY, content TEXT, part TEXT, page INTEGER);`,
    );
    const p = probeBook(open(path));
    expect(p.pageText).toBe("content");
  });

  it("reports null rather than guessing when part and printed page are absent", () => {
    const path = makeDb("bare-book", `CREATE TABLE book (id INTEGER PRIMARY KEY, nass TEXT);`);
    const p = probeBook(open(path));
    expect(p.pagePart).toBeNull();
    expect(p.pagePrinted).toBeNull();
    expect(p.notes.join(" ")).toContain("null");
  });

  it("throws with the table list when no text column exists", () => {
    const path = makeDb("no-text", `CREATE TABLE meta (k TEXT, v INTEGER);`);
    try {
      probeBook(open(path));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Fiqh4Error).code).toBe("SCHEMA_UNRECOGNISED");
      expect(JSON.stringify((e as Fiqh4Error).details)).toContain("meta");
    }
  });
});
