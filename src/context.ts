import { MasterCatalogue } from "./shamela/masterRepo.js";
import { Classifier } from "./classify/classifier.js";
import type { ClassifiedBook, Madhhab } from "./classify/types.js";
import { NodeSearchEngine } from "./search/nodeEngine.js";
import { LuceneSearchEngine } from "./search/luceneEngine.js";
import type { SearchEngine } from "./search/engine.js";
import { defaultIndexDir, defaultOutputDir } from "./util/paths.js";
import { envInt } from "./util/concurrency.js";
import { log } from "./util/log.js";
import { normalizeArabic } from "./text/normalize.js";

/**
 * Process-wide handles. Opening the catalogue means probing the schema and
 * scanning for book files, so it is done once and reused; every tool call after
 * the first is then cheap.
 */

export interface Settings {
  indexDir: string;
  outputDir: string;
  maxResultsPerResponse: number;
  maxResponseBytes: number;
  concurrency: number;
}

export function settings(): Settings {
  return {
    indexDir: defaultIndexDir(),
    outputDir: defaultOutputDir(),
    maxResultsPerResponse: envInt("FIQH4_MAX_RESULTS_PER_RESPONSE", 50, 1, 500),
    maxResponseBytes: envInt("FIQH4_MAX_RESPONSE_BYTES", 262_144, 16_384, 4_194_304),
    concurrency: envInt("FIQH4_CONCURRENCY", 4, 1, 16),
  };
}

let catalogueCache: MasterCatalogue | null = null;
let classifierCache: Classifier | null = null;
let booksCache: ClassifiedBook[] | null = null;

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
  if (!booksCache) booksCache = classifier().classifyAll(catalogue().books());
  return booksCache;
}

/** Drop cached state — used by tests and after the overrides file changes. */
export function resetContext(): void {
  catalogueCache?.close();
  catalogueCache = null;
  classifierCache = null;
  booksCache = null;
}

export interface BookFilter {
  madhhabs?: Madhhab[] | undefined;
  bookIds?: string[] | undefined;
  /** Only books whose database is present on disk. */
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
  id: "node-fts5" | "lucene";
  /** Why that backend was chosen, in Arabic, for fiqh4_health. */
  reason: string;
}

/**
 * Pick a backend. Lucene when the user has built and configured it, otherwise
 * the built-in Node engine. A Lucene failure is not fatal: we say so and fall
 * back, because an offline extension that refuses to search is worse than a
 * slower one.
 */
export async function openEngine(indexDir?: string): Promise<EngineHandle> {
  const dir = indexDir ?? settings().indexDir;

  if (LuceneSearchEngine.available()) {
    try {
      const engine = await LuceneSearchEngine.open(dir);
      await engine.refreshBooks();
      return { engine, id: "lucene", reason: "مُفعَّل عبر FIQH4_LUCENE_JAR." };
    } catch (e) {
      log.warn("Lucene bridge unavailable, falling back to the Node engine", {
        error: e instanceof Error ? e.message : String(e),
      });
      return {
        engine: NodeSearchEngine.open(dir),
        id: "node-fts5",
        reason: `تعذّر تشغيل جسر Lucene (${e instanceof Error ? e.message : String(e)})؛ استُخدم محرك Node.`,
      };
    }
  }

  return {
    engine: NodeSearchEngine.open(dir),
    id: "node-fts5",
    reason: "محرك Node الافتراضي (لم يُضبط FIQH4_LUCENE_JAR).",
  };
}
