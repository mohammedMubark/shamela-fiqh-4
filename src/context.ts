import { MasterCatalogue } from "./shamela/masterRepo.js";
import { Classifier } from "./classify/classifier.js";
import type { ClassifiedBook, Madhhab } from "./classify/types.js";
import { ShamelaSearchEngine } from "./search/shamelaEngine.js";
import type { SearchEngine } from "./search/engine.js";
import { defaultOutputDir } from "./util/paths.js";
import { luceneDir, resolveJava } from "./shamela/discover.js";
import { envInt, javaPath as configuredJavaPath } from "./config.js";
import { Fiqh4Error } from "./util/errors.js";
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
  engine: ShamelaSearchEngine;
  id: "lucene";
  /** How the runtime was resolved, for fiqh4_health. */
  reason: string;
}

/**
 * Open the search engine over Shamela's own Lucene index.
 *
 * There is no second engine to fall back to: this Shamela generation keeps all
 * book text in Lucene, so without the helper there is nothing to search. When
 * something is missing the error says exactly which piece and how to supply it,
 * rather than degrading to a silently empty search.
 */
export async function openEngine(): Promise<EngineHandle> {
  const loc = catalogue().location;

  // The configured path is passed explicitly rather than left to the resolver's
  // own environment read, so this call site shows which setting is in play.
  const java = resolveJava(loc.appDir, configuredJavaPath());
  if (!java.path) {
    throw new Fiqh4Error(
      "ENGINE_UNAVAILABLE",
      `تعذّر العثور على Java. المكتبة الشاملة تشحن نسختها الخاصة تحت app/<نظام>/jre/2/bin — ` +
        `تأكد أن مجلد app موجود داخل «${loc.root}»، أو اضبط FIQH4_JAVA_PATH على java تختاره.` +
        (java.ignoredConfigured
          ? ` (المسار المضبوط «${java.ignoredConfigured}» غير موجود، فلم يُستعمل.)`
          : ""),
      `No Java found. Shamela bundles one under app/<os>/jre/2/bin; or set FIQH4_JAVA_PATH.`,
      { app_dir: loc.appDir, tried: java.tried, ignored_configured: java.ignoredConfigured },
    );
  }

  const jars = luceneDir(loc.appDir);
  if (!jars) {
    throw new Fiqh4Error(
      "ENGINE_UNAVAILABLE",
      `تعذّر العثور على مكتبات Lucene التي تشحنها الشاملة في app/lucene/2 داخل «${loc.root}». ` +
        `هذه الإضافة لا تشحن Lucene؛ تستعمل نسخة الشاملة نفسها.`,
      `Shamela's Lucene jars not found at app/lucene/2.`,
      { app_dir: loc.appDir },
    );
  }

  const engine = await ShamelaSearchEngine.open({
    javaPath: java.path,
    luceneDir: jars,
    storeDir: loc.storeDir,
  });

  return {
    engine,
    id: "lucene",
    reason:
      java.source === "configured"
        ? `Java مضبوطة يدويًا (${java.path})، وLucene من app/lucene/2.`
        : `Java من الشاملة (${java.path})، وLucene من app/lucene/2.`,
  };
}
