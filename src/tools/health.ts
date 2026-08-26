import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allBooks, catalogue, classifier, resetContext, settings } from "../context.js";
import { MADHHAB_AR, MADHHAB_VALUES, type Madhhab } from "../classify/types.js";
import { acquireEngine } from "../context.js";
import { helperAvailable, helperClassesDir } from "../search/luceneBridge.js";
import { hasStoreIndex, luceneDir, resolveJava } from "../shamela/discover.js";
import { envReport, javaPath as configuredJavaPath, unresolvedPlaceholders } from "../config.js";
import { NORMALIZER_VERSION } from "../text/normalize.js";
import { Fiqh4Error } from "../util/errors.js";
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
        environment: z.object({}).passthrough(),
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

      // ── the Lucene runtime this all depends on ────────────────────────────
      //
      // Shamela keeps every page body in its own Lucene index, so these three
      // pieces — its jars, its Java, and our compiled helper — are what make
      // search possible at all. Each is reported separately because each fails
      // for a different reason and has a different fix.
      const java = resolveJava(cat.location.appDir, configuredJavaPath());
      const jars = luceneDir(cat.location.appDir);
      const helper = helperAvailable();
      const pageIndex = hasStoreIndex(cat.location, "page");
      const titleIndex = hasStoreIndex(cat.location, "title");

      if (!pageIndex) {
        warnings.push(
          "لا يوجد فهرس صفحات في database/store/page — لا يمكن البحث في النصوص. تأكد أن الكتب مُنزَّلة داخل برنامج الشاملة.",
        );
      }
      if (!jars) warnings.push("لم تُوجد مكتبات Lucene في app/lucene/2 داخل مجلد الشاملة.");
      if (!java.path) {
        warnings.push(
          `لم تُوجد Java. الشاملة تشحن نسختها تحت app/<نظام>/jre/2/bin. المسارات المجرَّبة: ${java.tried.join(" | ")}`,
        );
      }
      if (java.ignoredConfigured) {
        warnings.push(
          `المسار المضبوط في إعداد «مسار Java» لا يشير إلى ملف موجود («${java.ignoredConfigured}»)، فتُجوهل` +
            (java.path ? " واستُعملت Java التي تشحنها الشاملة." : " ولم تُوجد Java بديلة."),
        );
      }
      // An unsubstituted ${user_config.x} reaching the process means a field in
      // manifest.json has no `default`. It is dropped rather than obeyed, but
      // saying so here is what turns the next report of this into one call.
      const placeholders = unresolvedPlaceholders();
      if (placeholders.length > 0) {
        warnings.push(
          `وصلت قيم إعداد غير محلولة من العميل وتُجوهلت: ${placeholders.join("، ")}. ` +
            `أعد تثبيت الإضافة من حزمة محدَّثة، أو املأ هذه الحقول في إعدادات الإضافة.`,
        );
      }
      if (!helper) {
        warnings.push(`مساعد Lucene غير مبني (${helperClassesDir()}). ابنِه مرة واحدة: npm run build:java`);
      }

      let indexInfo: Record<string, unknown> = {
        source: "shamela",
        store_dir: cat.location.storeDir,
        page_index: pageIndex,
        title_index: titleIndex,
        normalizer_version: NORMALIZER_VERSION,
        note_ar:
          "لا تبني هذه الإضافة فهرسًا خاصًا بها. تستعلم فهرس الشاملة نفسه، فلا خطوة فهرسة ولا مساحة قرص إضافية.",
      };

      if (pageIndex && jars && java.path && helper) {
        try {
          const handle = await acquireEngine();
          try {
            const st = handle.engine.indexStats;
            indexInfo = {
              ...indexInfo,
              readable: true,
              page_documents: st?.pageDocs ?? null,
              index_generation: st?.pageGeneration ?? null,
              java_version: st?.javaVersion ?? null,
            };
          } finally {
            handle.release();
          }
        } catch (e) {
          // Pass the underlying cause through verbatim: when Java will not
          // start, its own message is the only thing that explains why, and a
          // paraphrase here leaves the user with nothing to act on.
          const detail = e instanceof Fiqh4Error ? e.messageAr : e instanceof Error ? e.message : String(e);
          indexInfo = {
            ...indexInfo,
            readable: false,
            error_code: e instanceof Fiqh4Error ? e.code : null,
            error: detail,
            java_stderr: e instanceof Fiqh4Error ? (e.details["stderr"] ?? null) : null,
          };
          warnings.push(`تعذّر فتح فهرس الشاملة: ${detail}`);
        }
      } else {
        indexInfo = { ...indexInfo, readable: false };
      }

      const engines = {
        active: "lucene",
        runtime_ar:
          "يعمل البحث على Java ومكتبات Lucene التي تشحنها الشاملة نفسها؛ هذه الإضافة لا تتضمن أيًّا منهما.",
        java_path: java.path,
        java_source: java.source,
        java_configured_ignored: java.ignoredConfigured,
        java_paths_tried: java.tried,
        lucene_dir: jars,
        helper_classes: helper ? helperClassesDir() : null,
      };

      const counts = cat.counts();
      if (counts.structure_only > 0) {
        warnings.push(
          `${counts.structure_only} كتابًا له ملف على القرص لكن نصّه غير مُنزَّل (بنية بلا متن)، فلن يظهر في نتائج البحث. نزّله من داخل برنامج الشاملة.`,
        );
      }

      const summary =
        `المكتبة: ${counts.catalogue} كتابًا في الفهرس، منها ${counts.downloaded} مُنزَّل. ` +
        `فهرس الشاملة: ${pageIndex ? "موجود" : "غير موجود"}. ` +
        `كتب بحاجة إلى مراجعة: ${needsReview.length}. ` +
        (warnings.length ? `تنبيهات: ${warnings.length}.` : "لا تنبيهات.");

      return ok(summary, {
        library: {
          root: cat.location.root,
          master_db: cat.location.masterDbPath,
          store_dir: cat.location.storeDir,
          app_dir: cat.location.appDir,
          resolved_from: cat.location.source,
          ...counts,
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
        // What this process actually received from the client. The Java
        // failure that motivated these fields was invisible from inside the
        // server: the message said "no Java" while the cause was a placeholder
        // in an environment variable no one could see.
        environment: {
          variables: envReport(),
          unresolved_placeholders: placeholders,
          note_ar:
            "state = set قيمة صريحة، empty تُعامل كغير مضبوطة، unresolved_placeholder قيمة لم يستبدلها العميل فتُجوهل.",
        },
        warnings_ar: warnings,
      });
    }),
  );
}
