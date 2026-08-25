import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openEngine, selectBooks, settings } from "../context.js";
import { MADHHAB_AR, MADHHAB_VALUES, type Madhhab } from "../classify/types.js";
import { envelope } from "../pipeline/batching.js";
import { Fiqh4Error } from "../util/errors.js";
import { clampLimit, guard, ok, outputSchema, zBatch, zBook, zMadhhab } from "./shared.js";

/**
 * Catalogue browsing. Paged with an ordinal cursor over a deterministic
 * ordering, so a caller walking a 3,000-book library gets every row exactly
 * once. The classification fields travel with every row: a caller should be
 * able to see *why* a book is filed where it is without a second call.
 */
export function registerListBooks(server: McpServer): void {
  server.registerTool(
    "fiqh4_list_books",
    {
      title: "استعراض الكتب وتصفيتها",
      description:
        "يسرد كتب المكتبة مع مذهبها ومصدر تصنيفها وحالة التحقق منها. يمكن التصفية حسب المذهب أو العنوان " +
        "أو المؤلف أو حالة التنزيل أو حالة التحقق، مع تصفّح على دفعات عبر cursor.",
      inputSchema: {
        madhhabs: z.array(zMadhhab).optional().describe("اقصر النتائج على هذه المذاهب."),
        title_contains: z.string().optional().describe("جزء من عنوان الكتاب (تُطبَّق مطابقة عربية متسامحة)."),
        author_contains: z.string().optional().describe("جزء من اسم المؤلف (تُطبَّق مطابقة عربية متسامحة)."),
        downloaded_only: z.boolean().optional().describe("اقصر النتائج على الكتب المُنزَّلة فعليًا."),
        verification_status: z
          .array(z.enum(["verified", "needs_review", "unverified"]))
          .optional()
          .describe("اقصر النتائج على حالات تحقق بعينها، مثل needs_review لمراجعة الملتبس."),
        ambiguous_only: z.boolean().optional().describe("اعرض الكتب ذات أسباب التباس فقط."),
        limit: z.number().int().optional().describe("عدد الكتب في الدفعة الواحدة. الافتراضي 50."),
        cursor: z.string().optional().describe("مؤشر متابعة من دفعة سابقة."),
      },
      outputSchema: outputSchema({
        books: z.array(zBook),
        batch: zBatch,
        totals: z.object({}).passthrough(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(
      async (args: {
        madhhabs?: string[];
        title_contains?: string;
        author_contains?: string;
        downloaded_only?: boolean;
        verification_status?: string[];
        ambiguous_only?: boolean;
        limit?: number;
        cursor?: string;
      }) => {
        const cfg = settings();
        const limit = clampLimit(args.limit, 50, 500);

        const handle = await openEngine();
        handle.engine.close();

        let books = selectBooks({
          madhhabs: args.madhhabs as Madhhab[] | undefined,
          downloadedOnly: args.downloaded_only,
          titleContains: args.title_contains,
          authorContains: args.author_contains,
        });

        if (args.verification_status && args.verification_status.length > 0) {
          const want = new Set(args.verification_status);
          books = books.filter((b) => want.has(b.verification_status));
        }
        if (args.ambiguous_only) books = books.filter((b) => b.ambiguity_reasons.length > 0);

        // Deterministic order — a cursor is only meaningful over a stable list.
        books.sort((a, b) => a.book_id.localeCompare(b.book_id, "en"));

        let start = 0;
        if (args.cursor) {
          const parsed = Number.parseInt(Buffer.from(args.cursor, "base64url").toString("utf8"), 10);
          if (!Number.isFinite(parsed) || parsed < 0) {
            throw new Fiqh4Error(
              "CURSOR_INVALID",
              "مؤشر التصفّح غير صالح. أعد الطلب بدون cursor.",
              "list_books cursor is not a valid ordinal.",
              {},
            );
          }
          start = parsed;
        }

        const page = books.slice(start, start + limit);
        const hasMore = start + page.length < books.length;

        const totals = {
          matched: books.length,
          downloaded: books.filter((b) => b.downloaded).length,
          needs_review: books.filter((b) => b.verification_status === "needs_review").length,
          by_madhhab: MADHHAB_VALUES.map((m: Madhhab) => ({
            madhhab: m,
            madhhab_ar: MADHHAB_AR[m],
            books: books.filter((b) => b.madhhab === m).length,
          })).filter((r) => r.books > 0),
        };

        const summary =
          `طابقت ${books.length} كتابًا (${totals.downloaded} مُنزَّل). ` +
          `أُعيد ${page.length} في هذه الدفعة` +
          (hasMore ? "، وبقي المزيد — استخدم next_cursor للمتابعة." : ".") +
          (totals.needs_review > 0 ? ` منها ${totals.needs_review} بحاجة إلى مراجعة تصنيف.` : "");

        return ok(summary, {
          books: page.map((b) => ({
            book_id: b.book_id,
            title: b.title,
            author: b.author,
            madhhab: b.madhhab,
            madhhab_ar: MADHHAB_AR[b.madhhab],
            downloaded: b.downloaded,
            category: b.category,
            category_id: b.category_id,
            classification_source: b.classification_source,
            verification_status: b.verification_status,
            ambiguity_reasons: b.ambiguity_reasons,
            matched_rule: b.matched_rule,
          })),
          batch: envelope({
            totalHits: books.length,
            returned: page.length,
            hasMore,
            nextCursor: hasMore
              ? Buffer.from(String(start + page.length), "utf8").toString("base64url")
              : null,
            reason: hasMore ? "max_results_per_response" : "none",
          }),
          totals,
          settings: { max_results_per_response: cfg.maxResultsPerResponse },
        });
      },
    ),
  );
}
