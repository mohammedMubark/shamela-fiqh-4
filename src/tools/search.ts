import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openEngine, selectBooks, settings } from "../context.js";
import { MADHHAB_AR, type Madhhab } from "../classify/types.js";
import { runBatchedSearch } from "../pipeline/search.js";
import type { MatchMode } from "../search/query.js";
import { clampLimit, guard, ok, outputSchema, scopeShape, zBatch, zMatchMode, zPassage } from "./shared.js";

/**
 * General search. Returns attributed passages one batch at a time; the caller
 * continues with next_cursor. The response always states the true total, so a
 * partial answer is never mistaken for a complete one.
 */
export function registerSearch(server: McpServer): void {
  server.registerTool(
    "fiqh4_search",
    {
      title: "بحث نصي داخل كتب المذاهب",
      description:
        "بحث نصي في الكتب المفهرسة بأحد أنماط المطابقة: phrase (عبارة متتابعة) أو all_terms (كل الكلمات في الصفحة) " +
        "أو any_terms (أي كلمة). يمكن حصره في مذاهب أو كتب محددة. يعيد المواضع منسوبة مع سبب المطابقة، " +
        "على دفعات مع total_hits وnext_cursor.",
      inputSchema: {
        query: z.string().min(1).describe("نص البحث بالعربية. يُطبَّع تطبيعًا محافظًا قبل المطابقة."),
        match_mode: zMatchMode.default("all_terms").describe("نمط المطابقة. الافتراضي all_terms."),
        ...scopeShape,
        limit: z.number().int().optional().describe("عدد المواضع في الدفعة الواحدة. الافتراضي من الإعدادات."),
        cursor: z.string().optional().describe("مؤشر متابعة من دفعة سابقة لنفس الاستعلام والفهرس."),
        include_full_text: z
          .boolean()
          .optional()
          .describe("أعِد نص الصفحة كاملًا في text_original. الافتراضي false للاكتفاء بالمقتطف."),
      },
      outputSchema: outputSchema({
        query: z.string(),
        match_mode: z.string(),
        passages: z.array(zPassage),
        batch: zBatch,
        scope: z.object({}).passthrough(),
        engine: z.object({}).passthrough(),
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
        include_full_text?: boolean;
      }) => {
        const cfg = settings();
        const limit = clampLimit(args.limit, cfg.maxResultsPerResponse, 500);

        const handle = await openEngine();
        try {
          const books = selectBooks({
            madhhabs: args.madhhabs as Madhhab[] | undefined,
            bookIds: args.book_ids,
            downloadedOnly: true,
          });

          const result = await runBatchedSearch({
            query: args.query,
            mode: (args.match_mode ?? "all_terms") as MatchMode,
            books,
            engine: handle.engine,
            limit,
            cursor: args.cursor,
            includeFullText: args.include_full_text === true,
            byteBudget: cfg.maxResponseBytes,
          });

          const perMadhhab = new Map<Madhhab, number>();
          for (const p of result.passages) {
            perMadhhab.set(p.madhhab, (perMadhhab.get(p.madhhab) ?? 0) + 1);
          }

          const summary =
            `إجمالي المواضع المطابقة: ${result.batch.total_hits}. ` +
            `أُعيد ${result.batch.returned} في هذه الدفعة` +
            (result.batch.has_more ? " — استخدم next_cursor للمتابعة." : " (اكتملت النتائج).") +
            (result.unindexed_books.length > 0
              ? ` تنبيه: ${result.unindexed_books.length} كتابًا في النطاق غير مفهرس ولم يُبحث فيه.`
              : "");

          return ok(summary, {
            query: args.query,
            match_mode: args.match_mode ?? "all_terms",
            passages: result.passages.map((p) => ({ ...p, madhhab_ar: MADHHAB_AR[p.madhhab] })),
            batch: result.batch,
            scope: {
              books_requested: books.length,
              books_searched: books.filter((b) => b.downloaded).length - result.unindexed_books.length,
              books_not_indexed: result.unindexed_books,
              books_unreadable: result.unreadable_books,
              by_madhhab_in_batch: [...perMadhhab.entries()].map(([m, n]) => ({
                madhhab: m,
                madhhab_ar: MADHHAB_AR[m],
                passages: n,
              })),
            },
            engine: {
              id: result.engine_id,
              reason_ar: handle.reason,
              index_fingerprint: result.index_fingerprint,
              query_hash: result.query_hash,
            },
            disclaimer_ar:
              "نتائج بحث نصي في الكتب المفهرسة فقط. اقتبس من text_original، ولا تُعامل غياب النتيجة كنفي لوجود قول.",
          });
        } finally {
          handle.engine.close();
        }
      },
    ),
  );
}
