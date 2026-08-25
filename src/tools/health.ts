import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allBooks, catalogue, classifier, openEngine, resetContext, settings } from "../context.js";
import { MADHHAB_AR, MADHHAB_VALUES, type Madhhab } from "../classify/types.js";
import { LuceneSearchEngine } from "../search/luceneEngine.js";
import { NORMALIZER_VERSION } from "../text/normalize.js";
import { guard, ok, outputSchema } from "./shared.js";

/**
 * Diagnostics. Deliberately verbose: almost every support question about this
 * extension ("why did it find nothing?") is answered by one of these fields —
 * an unbuilt index, an undownloaded book, or a category the map does not cover.
 */
export function registerHealth(server: McpServer): void {
  server.registerTool(
    "fiqh4_health",
    {
      title: "فحص حالة المكتبة والمحرك",
      description:
        "يفحص تثبيت المكتبة الشاملة، وبنية قواعد البيانات، وفهارس Lucene المباشرة، وتوافر Java، " +
        "ويعرض عدد الكتب في كل مذهب والكتب الملتبسة والفئات غير المصنَّفة. ابدأ به عند أي سلوك غير متوقع.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("أعد قراءة الفهرس وملف التجاوزات من القرص بدل استخدام النسخة المحفوظة في الذاكرة."),
      },
      outputSchema: outputSchema({
        library: z.object({}).passthrough(),
        schema: z.object({}).passthrough(),
        classification: z.object({}).passthrough(),
        index: z.object({}).passthrough(),
        engines: z.object({}).passthrough(),
        settings: z.object({}).passthrough(),
        warnings_ar: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async ({ refresh }: { refresh?: boolean }) => {
      if (refresh) resetContext();
      const warnings: string[] = [];
      const cfg = settings();

      const cat = catalogue();
      let books = allBooks();
      const cls = classifier();

      // ── direct Shamela Lucene index ──────────────────────────────────────
      let indexInfo: Record<string, unknown> = {
        source: "shamela_lucene_store",
        normalizer_version: NORMALIZER_VERSION,
      };
      let engines: Record<string, unknown> = {
        active: "lucene",
        lucene: {
          helper_jar: LuceneSearchEngine.helperJar(),
          lucene_dir: LuceneSearchEngine.luceneDir(cat.location),
          java_path: LuceneSearchEngine.javaPath(cat.location),
          available: LuceneSearchEngine.available(cat.location),
        },
      };
      try {
        const handle = await openEngine();
        const engine = handle.engine as LuceneSearchEngine;
        const health = engine.lastHealth() ?? (await engine.health());
        books = allBooks();
        const indexedIds = new Set(engine.indexedBooks().map((b) => b.book_id));
        const sqlitePresent = books.filter((b) => b.file_path);
        const notInLucene = sqlitePresent.filter((b) => !indexedIds.has(b.book_id));
        indexInfo = {
          ...indexInfo,
          page_index: health["page_index"],
          title_index: health["title_index"],
          page_docs: health["page_docs"],
          title_docs: health["title_docs"],
          page_commit: health["page_commit"],
          title_commit: health["title_commit"],
          books_with_lucene_pages: indexedIds.size,
          sqlite_book_files_present: sqlitePresent.length,
          sqlite_files_without_lucene_pages: notInLucene.length,
          exists: Boolean(health["page_index_exists"]),
        };
        engines = {
          active: "lucene",
          lucene: {
            ...engine.runtime,
            available: true,
            java_version: health["java_version"],
            lucene_version: health["lucene_version"],
            note_ar: "قراءة مباشرة من فهارس الشاملة، بلا فهرس مشتق.",
          },
        };
        if (notInLucene.length > 0) {
          warnings.push(
            `${notInLucene.length} ملف كتاب موجود في SQLite لكن لا توجد له صفحات في فهرس Lucene، ولن يظهر في البحث.`,
          );
        }
        handle.engine.close();
      } catch (e) {
        indexInfo = { ...indexInfo, exists: false, error: e instanceof Error ? e.message : String(e) };
        warnings.push(`تعذّر فتح فهارس Lucene المباشرة: ${e instanceof Error ? e.message : String(e)}`);
      }

      // ── classification breakdown ──────────────────────────────────────────
      const perMadhhab = MADHHAB_VALUES.map((m: Madhhab) => {
        const inM = books.filter((b) => b.madhhab === m);
        return {
          madhhab: m,
          madhhab_ar: MADHHAB_AR[m],
          books: inM.length,
          downloaded: inM.filter((b) => b.downloaded).length,
        };
      });

      const ambiguous = books.filter((b) => b.ambiguity_reasons.length > 0);
      const needsReview = books.filter((b) => b.verification_status === "needs_review");
      const unmapped = cls.unmappedCategories(books);

      if (unmapped.length > 0) {
        warnings.push(
          `توجد ${unmapped.length} فئة في مكتبتك لا تغطيها خريطة المذاهب، تضم ${unmapped.reduce((n, c) => n + c.book_count, 0)} كتابًا. راجِعها وأضِف قواعد أو تجاوزات.`,
        );
      }
      if (needsReview.length > 0) {
        warnings.push(
          `${needsReview.length} كتابًا بحاجة إلى مراجعة بشرية (verification_status = needs_review) قبل الاعتماد على نسبتها المذهبية.`,
        );
      }

      const counts = cat.counts();
      const luceneDownloaded = books.filter((b) => b.downloaded).length;
      const orphans = cat.orphanFiles();
      if (orphans.length > 0) {
        warnings.push(
          `${orphans.length} ملف كتاب على القرص ليس له سجل في فهرس المكتبة (master.db)، ولن يُصنَّف أو يُبحث فيه.`,
        );
      }

      const summary =
        `المكتبة: ${counts.catalogue} كتابًا في الفهرس، منها ${luceneDownloaded} له صفحات في Lucene. ` +
        `المحرك النشط: ${engines.active}. ` +
        `كتب بحاجة إلى مراجعة: ${needsReview.length}. ` +
        (warnings.length ? `تنبيهات: ${warnings.length}.` : "لا تنبيهات.");

      return ok(summary, {
        library: {
          root: cat.location.root,
          master_db: cat.location.masterDbPath,
          book_dirs: cat.location.bookDirs,
          resolved_from: cat.location.source,
          catalogue: counts.catalogue,
          downloaded: luceneDownloaded,
          sqlite_book_files_present: counts.downloaded,
          files_on_disk: counts.files_on_disk,
          orphan_book_files: orphans.length,
          access_mode: "read-only",
        },
        schema: {
          master: {
            books_table: cat.profile.booksTable,
            book_id_column: cat.profile.bookId,
            title_column: cat.profile.bookTitle,
            author_column: cat.profile.bookAuthorName ?? cat.profile.authorName,
            category_column: cat.profile.bookCategoryId,
            categories_table: cat.profile.categoriesTable,
            notes_ar: cat.profile.notes,
          },
          detected_tables: cat.profile.tables.map((t) => t.name),
        },
        classification: {
          map_file: cls.config.mapPath,
          overrides_file: cls.config.overridesPath,
          rules: cls.config.rules.length,
          overrides: cls.config.overrides.overrides.length,
          excluded_books: cls.config.overrides.exclude.length,
          force_included_books: cls.config.overrides.include.length,
          per_madhhab: perMadhhab,
          ambiguous_books: ambiguous.length,
          needs_review: needsReview.length,
          unmapped_categories: unmapped.slice(0, 50),
          unmapped_categories_total: unmapped.length,
        },
        index: indexInfo,
        engines,
        settings: {
          output_dir: cfg.outputDir,
          max_results_per_response: cfg.maxResultsPerResponse,
          max_response_bytes: cfg.maxResponseBytes,
          concurrency: cfg.concurrency,
          normalizer_version: NORMALIZER_VERSION,
        },
        warnings_ar: warnings,
      });
    }),
  );
}
