import { MasterCatalogue } from "./shamela/masterRepo.js";
import { Classifier } from "./classify/classifier.js";
import type { ClassifiedBook, Madhhab } from "./classify/types.js";
import { LuceneSearchEngine } from "./search/luceneEngine.js";
import type { IndexedBookInfo, SearchEngine } from "./search/engine.js";
import { defaultOutputDir } from "./util/paths.js";
import { envInt } from "./util/concurrency.js";
import { normalizeArabic } from "./text/normalize.js";

/**
 * Process-wide handles. Opening the catalogue means probing the schema and
 * scanning for book files, so it is done once and reused; every tool call after
 * the first is then cheap.
 */

export interface Settings {
  outputDir: string;
  maxResultsPerResponse: number;
  maxResponseBytes: number;
  concurrency: number;
}

export function settings(): Settings {
  return {
    outputDir: defaultOutputDir(),
    maxResultsPerResponse: envInt("FIQH4_MAX_RESULTS_PER_RESPONSE", 50, 1, 500),
    maxResponseBytes: envInt("FIQH4_MAX_RESPONSE_BYTES", 262_144, 16_384, 4_194_304),
    concurrency: envInt("FIQH4_CONCURRENCY", 4, 1, 16),
  };
}

let catalogueCache: MasterCatalogue | null = null;
let classifierCache: Classifier | null = null;
let booksCache: ClassifiedBook[] | null = null;
let luceneAvailableBookIds: Set<string> | null = null;

export function catalogue(): MasterCatalogue {
  if (!catalogueCache) catalogueCache = MasterCatalogue.open();
  return catalogueCache;
}

export function classifier(): Classifier {
  if (!classifierCache) classifierCache = Classifier.load();
  return classifierCache;
}

/** The full, classified catalogue. */
export function allBooks(): ClassifiedBook[] {
  if (!booksCache) booksCache = applyLuceneAvailability(classifier().classifyAll(catalogue().books()));
  return booksCache;
}

function applyLuceneAvailability(books: ClassifiedBook[]): ClassifiedBook[] {
  if (!luceneAvailableBookIds) return books;
  return books.map((b) => ({
    ...b,
    downloaded: b.file_path !== null && luceneAvailableBookIds!.has(b.book_id),
  }));
}

function rememberLuceneAvailability(indexedBooks: IndexedBookInfo[]): void {
  luceneAvailableBookIds = new Set(indexedBooks.map((b) => b.book_id));
  if (booksCache) booksCache = applyLuceneAvailability(booksCache);
}

/** Drop cached state — used by tests and after the overrides file changes. */
export function resetContext(): void {
  catalogueCache?.close();
  catalogueCache = null;
  classifierCache = null;
  booksCache = null;
  luceneAvailableBookIds = null;
}

export interface BookFilter {
  madhhabs?: Madhhab[] | undefined;
  bookIds?: string[] | undefined;
  /** Only books with a SQLite file and page content in Shamela's Lucene index. */
  downloadedOnly?: boolean | undefined;
  titleContains?: string | undefined;
  authorContains?: string | undefined;
}

/**
 * Resolve a scope request to concrete books.
 *
 * `include` entries from the overrides file survive a madhhab filter, because
 * the user has explicitly said those books belong in scope. `exclude` entries
 * are dropped during classification and never reach here.
 */
export function selectBooks(filter: BookFilter): ClassifiedBook[] {
  const cls = classifier();
  const books = allBooks();
  const wantIds = filter.bookIds && filter.bookIds.length > 0 ? new Set(filter.bookIds) : null;
  const wantMadhhabs = filter.madhhabs && filter.madhhabs.length > 0 ? new Set(filter.madhhabs) : null;

  return books.filter((b) => {
    if (wantIds) return wantIds.has(b.book_id);
    if (filter.downloadedOnly && !b.downloaded) return false;
    if (wantMadhhabs && !wantMadhhabs.has(b.madhhab) && !cls.isForceIncluded(b.book_id)) return false;
    if (filter.titleContains && !matches(b.title, filter.titleContains)) return false;
    if (filter.authorContains && !matches(b.author, filter.authorContains)) return false;
    return true;
  });
}

function matches(haystack: string | null, needle: string): boolean {
  if (!haystack) return false;
  // Compare in normalised space so a diacritic in the catalogue cannot hide a book.
  return normalizeArabic(haystack).includes(normalizeArabic(needle));
}

export interface EngineHandle {
  engine: SearchEngine;
  /** Which backend actually answered — surfaced in every search response. */
  id: "lucene";
  /** Why that backend was chosen, in Arabic, for fiqh4_health. */
  reason: string;
}

/**
 * Open the direct Shamela Lucene backend.
 *
 * The project no longer builds a derived index. Search is over Shamela's own
 * `database/store/page` index, using the helper jar plus Shamela's Lucene jars.
 */
export async function openEngine(): Promise<EngineHandle> {
  const cat = catalogue();
  const ids = allBooks().map((b) => b.book_id);
  const engine = await LuceneSearchEngine.open(cat.location, ids);
  rememberLuceneAvailability(engine.indexedBooks());
  return {
    engine,
    id: "lucene",
    reason: "قراءة مباشرة من فهارس Lucene الموجودة داخل تثبيت الشاملة.",
  };
}
