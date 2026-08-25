import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { catalogue, openEngine, selectBooks, settings } from "../context.js";
import type { Madhhab } from "../classify/types.js";
import { exportResults } from "../pipeline/exportResults.js";
import { resolveSafeOutputDir } from "../util/paths.js";
import type { MatchMode } from "../search/query.js";
import { LuceneTextSource } from "../shamela/luceneText.js";
import { guard, ok, outputSchema, scopeShape, zMatchMode } from "./shared.js";

/**
 * Exhaustive export to disk.
 *
 * This is the escape hatch from batching: instead of trying to push a hundred
 * thousand rows through the protocol, we sweep every selected book to the end
 * and stream JSONL to a file, returning only the summary and a checksum.
 *
 * Writes are confined to the configured output directory — never the Shamela
 * folder — and every path is re-validated here even though the pipeline also
 * checks, because this is the only tool in the set that writes anything.
 */
export function registerExportResults(server: McpServer): void {
  server.registerTool(
    "fiqh4_export_results",
    {
      title: "تصدير كل النتائج إلى ملفات",
      description:
        "يفحص جميع الكتب المختارة حتى النهاية ويصدّر كل المواضع إلى JSONL وتقرير Markdown مع manifest وchecksum. " +
        "يكتب تدريجيًا بذاكرة شبه ثابتة، ويدعم الاستئناف بعد الانقطاع عبر نفس job_id. " +
        "لا يكتب داخل مجلد المكتبة الشاملة إطلاقًا.",
      inputSchema: {
        query: z.string().min(1).describe("نص البحث."),
        match_mode: zMatchMode.default("all_terms").describe("نمط المطابقة. الافتراضي all_terms."),
        ...scopeShape,
        job_id: z
          .string()
          .min(1)
          .describe(
            "معرّف المهمة، ويصير اسم مجلد التصدير. أعِد استخدام نفس المعرّف لاستئناف تصدير انقطع.",
          ),
        output_dir: z
          .string()
          .optional()
          .describe(
            "مجلد إخراج بديل. المسارات النسبية تُحل داخل مجلد الإخراج المضبوط، وأي مسار خارجه أو داخل مجلد الشاملة يُرفض.",
          ),
        all_results: z
          .boolean()
          .optional()
          .describe("استقصاء كامل لكل المواضع. الافتراضي true — وهو الغرض من هذه الأداة."),
        include_full_text: z
          .boolean()
          .optional()
          .describe("ضمّن نص كل صفحة كاملًا في الملف. الافتراضي true. يُكبِّر حجم الملف كثيرًا."),
        concurrency: z
          .number()
          .int()
          .optional()
          .describe("عدد الكتب المفحوصة على التوازي. الافتراضي من الإعدادات (4)."),
      },
      outputSchema: outputSchema({
        job_id: z.string(),
        output_path: z.string(),
        checksum: z.string(),
        total_hits: z.number(),
        by_madhhab: z.array(z.object({}).passthrough()),
        by_book: z.array(z.object({}).passthrough()),
        files: z.array(z.object({}).passthrough()),
        failed_books: z.array(z.object({}).passthrough()),
        skipped_books: z.array(z.object({}).passthrough()),
        resume: z.object({}).passthrough(),
        engine: z.object({}).passthrough(),
        disclaimer_ar: z.string(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    guard(
      async (args: {
        query: string;
        match_mode?: string;
        madhhabs?: string[];
        book_ids?: string[];
        job_id: string;
        output_dir?: string;
        all_results?: boolean;
        include_full_text?: boolean;
        concurrency?: number;
      }) => {
        const cfg = settings();

        // Resolved against the Shamela root so a write into the library is
        // rejected here, before any file is created.
        const outputDir = resolveSafeOutputDir({
          requested: args.output_dir,
          outputRoot: cfg.outputDir,
          shamelaDir: catalogue().location.root,
          create: true,
        });

        const books = selectBooks({
          madhhabs: args.madhhabs as Madhhab[] | undefined,
          bookIds: args.book_ids,
        });

        const handle = await openEngine();
        try {
          const result = await exportResults({
            text: new LuceneTextSource(handle.engine),
            query: args.query,
            mode: (args.match_mode ?? "all_terms") as MatchMode,
            books,
            engine: handle.engine,
            outputDir,
            jobId: args.job_id,
            concurrency: args.concurrency ?? cfg.concurrency,
            includeFullText: args.include_full_text !== false,
          });

          const spread = result.by_madhhab
            .map((m) => `${m.madhhab_ar}: ${m.hits}`)
            .join("، ");

          const summary =
            `اكتمل التصدير: ${result.total_hits} موضعًا من ${result.by_book.filter((b) => b.hits > 0).length} كتابًا ` +
            `في ${Math.round(result.elapsed_ms / 100) / 10} ثانية. ` +
            (spread ? `التوزيع — ${spread}. ` : "") +
            `المسار: ${result.output_path}. ` +
            (result.resumed_from_checkpoint
              ? `استُؤنف من نقطة سابقة (${result.books_reused_from_checkpoint} كتابًا لم يُعد فحصها). `
              : "") +
            (result.failed_books.length > 0 ? `فشل جلب ${result.failed_books.length} كتابًا. ` : "") +
            (result.skipped_books.length > 0 ? `تُخطّي ${result.skipped_books.length} كتابًا.` : "");

          return ok(summary, {
            job_id: result.job_id,
            output_path: result.output_path,
            checksum: result.checksum,
            total_hits: result.total_hits,
            by_madhhab: result.by_madhhab,
            by_book: result.by_book,
            files: result.files,
            failed_books: result.failed_books,
            skipped_books: result.skipped_books,
            resume: {
              resumed_from_checkpoint: result.resumed_from_checkpoint,
              books_reused: result.books_reused_from_checkpoint,
              note_ar:
                "لاستئناف تصدير انقطع، أعد الاستدعاء بنفس job_id ونفس الاستعلام. " +
                "الكتب المكتملة لن يُعاد فحصها، والكتاب المنقطع يُعاد من أوله فلا يتكرر سطر ولا يسقط.",
            },
            engine: {
              id: result.engine_id,
              index_fingerprint: result.index_fingerprint,
              query_hash: result.query_hash,
              normalizer_version: result.normalizer_version,
              elapsed_ms: result.elapsed_ms,
            },
            disclaimer_ar:
              "الملفات نتيجة بحث نصي في الكتب المفهرسة فقط، وليست حكمًا فقهيًا ولا ترجيحًا ولا إجماعًا.",
          });
        } finally {
          handle.engine.close();
        }
      },
    ),
  );
}
