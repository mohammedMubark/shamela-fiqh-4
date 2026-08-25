import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allBooks, openEngine, selectBooks, settings } from "../context.js";
import { MADHHABS, type Madhhab } from "../classify/types.js";
import { runBatchedSearch } from "../pipeline/search.js";
import { fetchPassages } from "../pipeline/fetchPassages.js";
import { compareIssue, COMPARISON_DISCLAIMER } from "../pipeline/compareIssue.js";
import type { MatchMode } from "../search/query.js";
import { clampLimit, guard, ok, outputSchema, zBatch, zMatchMode } from "./shared.js";

/**
 * Side-by-side comparison.
 *
 * Groups attributed passages by madhhab and book. It reports which schools
 * produced evidence and which produced none, and it stops there: there is no
 * ruling field, no preponderance, no synthesised consensus — those are the
 * reader's to draw, from texts they can verify in place.
 */
export function registerCompareIssue(server: McpServer): void {
  server.registerTool(
    "fiqh4_compare_issue",
    {
      title: "مقارنة المسألة بين المذاهب",
      description:
        "يجمع مواضع المسألة ويرتّبها حسب المذهب ثم الكتاب لعرضها متقابلة، مع بيان المذاهب التي لم تُطابق. " +
        "لا يُصدر حكمًا ولا يرجّح ولا يُثبت إجماعًا؛ يعرض النصوص منسوبة إلى مصادرها فقط.",
      inputSchema: {
        query: z.string().min(1).describe("نص المسألة."),
        match_mode: zMatchMode.default("all_terms").describe("نمط المطابقة. الافتراضي all_terms."),
        madhhabs: z
          .array(z.enum(MADHHABS as unknown as [string, ...string[]]))
          .optional()
          .describe("المذاهب المطلوب مقارنتها. الافتراضي: المذاهب الأربعة."),
        book_ids: z.array(z.string()).optional().describe("حصر المقارنة في كتب بعينها."),
        per_madhhab_limit: z
          .number()
          .int()
          .optional()
          .describe("أقصى عدد مواضع تُجلب لكل مذهب. الافتراضي 8."),
        neighbors: z.number().int().optional().describe("صفحات مجاورة تُضاف لسياق كل موضع. الافتراضي 0."),
        include_full_text: z.boolean().optional().describe("أعِد نص الصفحة كاملًا. الافتراضي false."),
      },
      outputSchema: outputSchema({
        query: z.string(),
        match_mode: z.string(),
        groups: z.array(z.object({}).passthrough()),
        summary: z.object({}).passthrough(),
        coverage: z.object({}).passthrough(),
        disclaimer_ar: z.string(),
        batch: zBatch.optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(
      async (args: {
        query: string;
        match_mode?: string;
        madhhabs?: string[];
        book_ids?: string[];
        per_madhhab_limit?: number;
        neighbors?: number;
        include_full_text?: boolean;
      }) => {
        const cfg = settings();
        const mode = (args.match_mode ?? "all_terms") as MatchMode;
        const requested = (args.madhhabs ?? [...MADHHABS]) as Madhhab[];
        const perLimit = clampLimit(args.per_madhhab_limit, 8, 100);

        const handle = await openEngine();
        try {
          // Search each school separately so one prolific book cannot crowd the
          // others out of a single global top-N.
          const collected: Awaited<ReturnType<typeof runBatchedSearch>>["passages"] = [];
          const perMadhhabCoverage: Array<{
            madhhab: Madhhab;
            total_hits: number;
            returned: number;
            books_searched: number;
            books_not_indexed: number;
          }> = [];

          for (const madhhab of requested) {
            const books = selectBooks({
              madhhabs: [madhhab],
              bookIds: args.book_ids,
              downloadedOnly: true,
            });
            if (books.length === 0) {
              perMadhhabCoverage.push({
                madhhab,
                total_hits: 0,
                returned: 0,
                books_searched: 0,
                books_not_indexed: 0,
              });
              continue;
            }

            const res = await runBatchedSearch({
              query: args.query,
              mode,
              books,
              engine: handle.engine,
              limit: perLimit,
              includeFullText: args.include_full_text === true,
              byteBudget: Math.floor(cfg.maxResponseBytes / Math.max(1, requested.length)),
            });

            collected.push(...res.passages);
            perMadhhabCoverage.push({
              madhhab,
              total_hits: res.batch.total_hits,
              returned: res.batch.returned,
              books_searched: books.length - res.unindexed_books.length,
              books_not_indexed: res.unindexed_books.length,
            });
          }

          // Optional context pages, fetched through the same de-duplicating path.
          let passages = collected;
          if ((args.neighbors ?? 0) > 0 && collected.length > 0) {
            const byBook = new Map<string, number[]>();
            for (const p of collected) {
              const list = byBook.get(p.book_id) ?? [];
              list.push(p.page_id);
              byBook.set(p.book_id, list);
            }
            const fetched = await fetchPassages({
              query: args.query,
              mode,
              requests: [...byBook.entries()].map(([book_id, page_ids]) => ({ book_id, page_ids })),
              books: allBooks(),
              engine: handle.engine,
              neighbors: args.neighbors ?? 0,
              limit: collected.length * (2 * (args.neighbors ?? 0) + 1),
              byteBudget: cfg.maxResponseBytes,
              includeFullText: args.include_full_text === true,
            });
            passages = fetched.passages;
          }

          const result = compareIssue({
            query: args.query,
            matchMode: mode,
            passages,
            requested,
          });

          const present = result.summary.madhhabs_with_evidence.length;
          const absent = result.summary.madhhabs_without_evidence;
          const summary =
            `جُمعت ${result.summary.total_passages} موضعًا من ${result.summary.total_books} كتابًا، ` +
            `في ${present} من ${requested.length} مذهبًا مطلوبًا.` +
            (absent.length > 0
              ? ` لم تُطابق أي صفحة في: ${absent.join("، ")} — وهذا غياب مطابقة نصية لا نفي لوجود قول.`
              : "") +
            " الأداة لا ترجّح ولا تُفتي.";

          return ok(summary, {
            query: result.query,
            match_mode: result.match_mode,
            groups: result.groups,
            summary: result.summary,
            coverage: {
              per_madhhab: perMadhhabCoverage,
              note_ar:
                "total_hits لكل مذهب هو إجمالي المواضع المطابقة، وreturned هو ما جُلب فعلًا ضمن per_madhhab_limit. " +
                "لاستقصاء كامل استخدم fiqh4_export_results.",
            },
            disclaimer_ar: COMPARISON_DISCLAIMER,
          });
        } finally {
          handle.engine.close();
        }
      },
    ),
  );
}
