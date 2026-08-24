import { openReadOnly, str, num, type ReadOnlyDb } from "./sqlite.js";
import { probeMaster, quoteIdent, type MasterProfile } from "./schemaProbe.js";
import { indexBookFiles, locateLibrary, type LibraryLocation } from "./discover.js";

/**
 * Reads the library catalogue. Every column reference goes through the probed
 * profile, so this file contains no hardcoded Shamela column names.
 */

export interface RawBook {
  book_id: string;
  title: string | null;
  author: string | null;
  category_id: string | null;
  category: string | null;
  /** Whether the book's own database is actually present on disk. */
  downloaded: boolean;
  file_path: string | null;
}

export interface CategoryRow {
  id: string;
  name: string;
}

export class MasterCatalogue {
  readonly location: LibraryLocation;
  readonly profile: MasterProfile;
  private readonly db: ReadOnlyDb;
  private readonly files: Map<string, string>;
  private booksCache: RawBook[] | null = null;

  private constructor(loc: LibraryLocation, db: ReadOnlyDb, profile: MasterProfile) {
    this.location = loc;
    this.db = db;
    this.profile = profile;
    this.files = indexBookFiles(loc);
  }

  static open(explicitRoot?: string): MasterCatalogue {
    const loc = locateLibrary(explicitRoot);
    const db = openReadOnly(loc.masterDbPath);
    return new MasterCatalogue(loc, db, probeMaster(db));
  }

  close(): void {
    this.db.close();
  }

  categories(): CategoryRow[] {
    const p = this.profile;
    if (!p.categoriesTable || !p.categoryId || !p.categoryName) return [];
    const rows = this.db.all(
      `SELECT ${quoteIdent(p.categoryId)} AS id, ${quoteIdent(p.categoryName)} AS name
         FROM ${quoteIdent(p.categoriesTable)}`,
    );
    return rows
      .map((r) => ({ id: String(r["id"] ?? ""), name: str(r["name"]) ?? "" }))
      .filter((c) => c.id !== "");
  }

  /** Full catalogue, joined to category names and to on-disk availability. */
  books(): RawBook[] {
    if (this.booksCache) return this.booksCache;
    const p = this.profile;

    const cols = [
      `b.${quoteIdent(p.bookId)} AS book_id`,
      `b.${quoteIdent(p.bookTitle)} AS title`,
    ];
    cols.push(p.bookCategoryId ? `b.${quoteIdent(p.bookCategoryId)} AS category_id` : `NULL AS category_id`);

    // Author may live on the book row, in a separate table, or nowhere.
    let joinAuthors = "";
    if (p.bookAuthorName) {
      cols.push(`b.${quoteIdent(p.bookAuthorName)} AS author`);
    } else if (p.authorsTable && p.authorId && p.authorName && p.bookAuthorId) {
      cols.push(`a.${quoteIdent(p.authorName)} AS author`);
      joinAuthors = ` LEFT JOIN ${quoteIdent(p.authorsTable)} a ON a.${quoteIdent(p.authorId)} = b.${quoteIdent(p.bookAuthorId)}`;
    } else {
      cols.push(`NULL AS author`);
    }

    let joinCats = "";
    if (p.categoriesTable && p.categoryId && p.categoryName && p.bookCategoryId) {
      cols.push(`c.${quoteIdent(p.categoryName)} AS category`);
      joinCats = ` LEFT JOIN ${quoteIdent(p.categoriesTable)} c ON c.${quoteIdent(p.categoryId)} = b.${quoteIdent(p.bookCategoryId)}`;
    } else {
      cols.push(`NULL AS category`);
    }

    const rows = this.db.all(
      `SELECT ${cols.join(", ")} FROM ${quoteIdent(p.booksTable)} b${joinAuthors}${joinCats}`,
    );

    this.booksCache = rows.map((r) => {
      const id = String(r["book_id"] ?? "").trim();
      const file = this.files.get(id) ?? null;
      return {
        book_id: id,
        title: str(r["title"]),
        author: str(r["author"]),
        category_id: r["category_id"] === null || r["category_id"] === undefined ? null : String(r["category_id"]),
        category: str(r["category"]),
        downloaded: file !== null,
        file_path: file,
      };
    }).filter((b) => b.book_id !== "");

    return this.booksCache;
  }

  bookById(id: string): RawBook | undefined {
    return this.books().find((b) => b.book_id === id);
  }

  /**
   * Book databases present on disk but absent from the catalogue. Worth
   * surfacing: they are searchable content the catalogue cannot describe.
   */
  orphanFiles(): string[] {
    const known = new Set(this.books().map((b) => b.book_id));
    return [...this.files.keys()].filter((id) => !known.has(id));
  }

  counts(): { catalogue: number; downloaded: number; files_on_disk: number } {
    const all = this.books();
    return {
      catalogue: all.length,
      downloaded: all.filter((b) => b.downloaded).length,
      files_on_disk: this.files.size,
    };
  }
}

export { num };
