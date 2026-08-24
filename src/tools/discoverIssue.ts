import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openEngine, selectBooks, settings } from "../context.js";
import type { Madhhab } from "../classify/types.js";
import { discoverIssue } from "../pipeline/discoverIssue.js";
import type { MatchMode } from "../search/query.js";
import { clampLimit, guard, ok, outputSchema, scopeShape, zBatch, zMatchMode } from "./shared.js";

/**
 * Phase one of the two-phase workflow.
 *
 * Answers "where does this issue appear?" across the whole scope without
 * fetching a single page of text. Totals are exact even while the per-book list
 * is batched, so the caller can size the job before committing to phase two.
 */
export function registerDiscoverIssue(server: McpServer): void {
  server.registerTool(
    "fiqh4_discover_issue",
    {
      title: "المرحلة الأولى: تحديد مواضع المسألة",
      description:
        "المرحلة الأولى من دراسة مسألة: يحدد كل الكتب التي وردت فيها المسألة وعدد المواضع في كل كتاب " +
        "وعينة من أرقام الصفحات، موزعة على المذاهب — دون جلب النصوص. استخدم مخرجاته مدخلًا لـ fiqh4_fetch_passages.",
      inputSchema: {
        query: z.string().min(1).describe("نص المسألة أو كلماتها المميزة."),
        match_mode: zMatchMode.default("all_terms").describe("نمط المطابقة. الافتراضي all_terms."),
        ...scopeShape,
        limit: z.number().int().optional().describe("عدد الكتب في الدفعة الواحدة. الافتراضي 25."),
        cursor: z.string().optional().describe("مؤشر متابعة لاستكمال سرد الكتب."),
        page_sample: z
          .number()
          .int()
          .optional()
          .describe("عدد أرقام الصفحات المعروضة لكل كتاب. الافتراضي 20؛ page_ids_truncated يبيّن وجود المزيد."),
      },
      outputSchema: outputSchema({
        query: z.string(),
        match_mode: z.string(),
        totals: z.object({}).passthrough(),
        books: z.array(z.object({}).passthrough()),
        batch: zBatch,
        coverage: z.object({}).passthrough(),
        engine: z.object({}).passthrough(),
        next_step_ar: z.string(),
        disclaimer_ar: z.string(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(
      async (args: {
        query: string;
        match_mode?: string;
        madhhabs?: string[];
        book_ids?: string[];
        limit?: number;
        cursor?: string;
        page_sample?: number;
      }) => {
        const cfg = settings();
        const books = selectBooks({
          madhhabs: args.madhhabs as Madhhab[] | undefined,
          bookIds: args.book_ids,
        });

        const handle = await openEngine();
        try {
          const result = await discoverIssue({
            query: args.query,
            mode: (args.match_mode ?? "all_terms") as MatchMode,
            books,
            engine: handle.engine,
            limit: clampLimit(args.limit, 25, 200),
            cursor: args.cursor,
            pageSample: clampLimit(args.page_sample, 20, 200),
          });

          const spread = result.totals.by_madhhab
            .map((m) => `${m.madhhab_ar}: ${m.hits} موضعًا في ${m.books} كتابًا`)
            .join("، ");

          const summary =
            `وردت المسألة في ${result.totals.books_with_hits} كتابًا من ${result.totals.books_searched} كتابًا مفهرسًا، ` +
            `بإجمالي ${result.totals.total_hits} موضعًا.` +
            (spread ? ` التوزيع — ${spread}.` : "") +
            (result.batch.has_more ? " سرد الكتب على دفعات؛ تابع بـ next_cursor." : "") +
            (result.coverage.books_not_indexed.length > 0
              ? ` تنبيه: ${result.coverage.books_not_indexed.length} كتابًا مُنزَّلًا غير مفهرس.`
              : "");

          return ok(summary, {
            query: result.query,
            match_mode: result.match_mode,
            totals: result.totals,
            books: result.books,
            batch: result.batch,
            coverage: result.coverage,
            engine: {
              id: result.engine_id,
              reason_ar: handle.reason,
              index_fingerprint: result.index_fingerprint,
              query_hash: result.query_hash,
            },
            next_step_ar:
              "مرّر book_id وpage_ids من هذه النتيجة إلى fiqh4_fetch_passages لجلب النصوص مع الصفحات المجاورة، " +
              "أو استخدم fiqh4_export_results إن أردت استقصاءً كاملًا إلى ملفات.",
            disclaimer_ar:
              "هذه خريطة مواضع نصية فقط. عدد المواضع ليس دليلًا على قوة القول، وخلوّ مذهب لا يعني عدم وجود قول له.",
            settings: { max_results_per_response: cfg.maxResultsPerResponse },
          });
        } finally {
          handle.engine.close();
        }
      },
    ),
  );
}
