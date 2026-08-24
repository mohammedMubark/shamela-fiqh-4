import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allBooks, catalogue, classifier, resetContext, settings } from "../context.js";
import { MADHHAB_AR, MADHHAB_VALUES, type Madhhab } from "../classify/types.js";
import { NodeSearchEngine } from "../search/nodeEngine.js";
import { LuceneSearchEngine } from "../search/luceneEngine.js";
import { luceneJarPath, javaBin } from "../search/luceneBridge.js";
import { NORMALIZER_VERSION } from "../text/normalize.js";
import { INDEX_SCHEMA_VERSION, indexPath } from "../search/indexDb.js";
import { isFile } from "../util/paths.js";
import { guard, ok, outputSchema } from "./shared.js";
import { execFileSync } from "node:child_process";

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
        "يفحص تثبيت المكتبة الشاملة، وبنية قواعد البيانات، وحالة فهرس البحث، وتوافر Java/Lucene، " +
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
      const books = allBooks();
      const cls = classifier();

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

      // ── index ─────────────────────────────────────────────────────────────
      const idxPath = indexPath(cfg.indexDir);
      const indexExists = isFile(idxPath);
      let indexInfo: Record<string, unknown> = {
        path: idxPath,
        exists: indexExists,
        schema_version: INDEX_SCHEMA_VERSION,
        normalizer_version: NORMALIZER_VERSION,
      };

      if (!indexExists) {
        warnings.push(`لا يوجد فهرس بحث بعد. ابنِه بتشغيل: npm run fiqh4:index`);
      } else {
        try {
          const engine = NodeSearchEngine.open(cfg.indexDir);
          const stats = engine.stats();
          const indexedIds = new Set(engine.indexedBooks().map((b) => b.book_id));
          const downloaded = books.filter((b) => b.downloaded);
          const missing = downloaded.filter((b) => !indexedIds.has(b.book_id));
          indexInfo = {
            ...indexInfo,
            ...stats,
            books_downloaded: downloaded.length,
            books_indexed: stats.books,
            books_downloaded_but_not_indexed: missing.length,
          };
          if (missing.length > 0) {
            warnings.push(
              `${missing.length} كتابًا مُنزَّلًا غير موجود في الفهرس، ولن يظهر في نتائج البحث. أعد بناء الفهرس.`,
            );
          }
          engine.close();
        } catch (e) {
          indexInfo = { ...indexInfo, error: e instanceof Error ? e.message : String(e) };
          warnings.push(`تعذّر قراءة الفهرس: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // ── engines ───────────────────────────────────────────────────────────
      const jar = luceneJarPath();
      let javaVersion: string | null = null;
      if (jar) {
        try {
          javaVersion = execFileSync(javaBin(), ["-version"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          })
            .split("\n")[0]
            ?.trim() ?? null;
        } catch {
          javaVersion = null;
        }
      }

      const engines = {
        active: LuceneSearchEngine.available() && javaVersion ? "lucene" : "node-fts5",
        node_fts5: { available: true, note_ar: "محرك مدمج يعمل دائمًا بلا Java." },
        lucene: {
          available: jar !== null,
          jar_path: jar,
          java_bin: javaBin(),
          java_version: javaVersion,
          note_ar: jar
            ? javaVersion
              ? "جسر Lucene مضبوط وJava متاحة."
              : "المسار مضبوط لكن تعذّر تشغيل Java؛ سيُستخدم محرك Node."
            : "غير مفعّل. اختياري: ابنِه بـ npm run java:build واضبط FIQH4_LUCENE_JAR.",
        },
      };
      if (jar && !javaVersion) {
        warnings.push("FIQH4_LUCENE_JAR مضبوط لكن تعذّر تشغيل Java. سيُستخدم محرك Node الافتراضي.");
      }

      const counts = cat.counts();
      const orphans = cat.orphanFiles();
      if (orphans.length > 0) {
        warnings.push(
          `${orphans.length} ملف كتاب على القرص ليس له سجل في فهرس المكتبة (master.db)، ولن يُصنَّف أو يُبحث فيه.`,
        );
      }

      const summary =
        `المكتبة: ${counts.catalogue} كتابًا في الفهرس، منها ${counts.downloaded} مُنزَّل. ` +
        `المحرك النشط: ${engines.active}. ` +
        `كتب بحاجة إلى مراجعة: ${needsReview.length}. ` +
        (warnings.length ? `تنبيهات: ${warnings.length}.` : "لا تنبيهات.");

      return ok(summary, {
        library: {
          root: cat.location.root,
          master_db: cat.location.masterDbPath,
          book_dirs: cat.location.bookDirs,
          resolved_from: cat.location.source,
          ...counts,
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
          index_dir: cfg.indexDir,
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
