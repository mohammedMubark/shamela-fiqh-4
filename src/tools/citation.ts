import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { allBooks, openEngine } from "../context.js";
import { LuceneTextSource } from "../shamela/luceneText.js";
import { MADHHAB_AR } from "../classify/types.js";
import { BookReader } from "../shamela/bookRepo.js";
import { NUMBERING_NOTE } from "../pipeline/passage.js";
import { Fiqh4Error } from "../util/errors.js";
import { guard, ok, outputSchema } from "./shared.js";

/**
 * Citation building.
 *
 * The discipline here is entirely about what it refuses to do. If Shamela has
 * no printed page for a location, `printed_page` is null and the formatted
 * string says so; it does not fall back to the internal page id dressed up as a
 * page number. Edition is always null — Shamela's databases do not carry one,
 * and a plausible-looking invented edition is worse than an absent one.
 */
export function registerCitation(server: McpServer): void {
  server.registerTool(
    "fiqh4_citation",
    {
      title: "بناء إحالة دقيقة",
      description:
        "يبني إحالة لموضع محدد (كتاب/جزء/صفحة) من بيانات الكتاب الفعلية، ويصرّح بأن الترقيم ترقيم المكتبة الشاملة. " +
        "لا يخترع طبعة ولا رقم صفحة مطبوعة؛ ما لا تسجّله الشاملة يُعاد بقيمة null.",
      inputSchema: {
        book_id: z.string().min(1).describe("معرّف الكتاب."),
        page_id: z.number().int().describe("معرّف الصفحة داخل قاعدة بيانات الكتاب."),
        include_text: z.boolean().optional().describe("ضمّن نص الصفحة كاملًا. الافتراضي false."),
      },
      outputSchema: outputSchema({
        citation: z.object({}).passthrough(),
        formatted_ar: z.string(),
        formatted_short_ar: z.string(),
        caveats_ar: z.array(z.string()),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guard(async (args: { book_id: string; page_id: number; include_text?: boolean }) => {
      const book = allBooks().find((b) => b.book_id === args.book_id);
      if (!book) {
        throw new Fiqh4Error(
          "BOOK_NOT_FOUND",
          `لا يوجد كتاب بالمعرّف «${args.book_id}» في فهرس المكتبة، أو أنه مستبعَد عبر ملف التجاوزات.`,
          `Book ${args.book_id} not found in the catalogue.`,
          { book_id: args.book_id },
        );
      }
      if (!book.downloaded || !book.file_path) {
        throw new Fiqh4Error(
          "BOOK_NOT_DOWNLOADED",
          `الكتاب «${book.title ?? book.book_id}» غير مُنزَّل، فلا يمكن التحقق من الصفحة. نزّله من برنامج الشاملة ثم أعد المحاولة.`,
          `Book ${args.book_id} is not downloaded.`,
          { book_id: args.book_id },
        );
      }

      const handle = await openEngine();
      const text = new LuceneTextSource(handle.engine);
      const reader = BookReader.open(book.file_path);
      try {
        const page = reader.pageById(args.page_id);
        if (page && args.include_text === true) {
          await reader.withText([page], text, book.book_id);
        }
        if (!page) {
          throw new Fiqh4Error(
            "BOOK_NOT_FOUND",
            `الصفحة ${args.page_id} غير موجودة في الكتاب «${book.title ?? book.book_id}».`,
            `Page ${args.page_id} not found in book ${args.book_id}.`,
            { book_id: args.book_id, page_id: args.page_id },
          );
        }

        const tocPath = await reader.tocPathWithText(page.page_id, text, book.book_id);
        const caveats: string[] = [NUMBERING_NOTE];
        if (page.printed_page === null) {
          caveats.push("لم تسجّل الشاملة رقم صفحة مطبوعة لهذا الموضع، فالقيمة null ولم تُخمَّن.");
        }
        if (page.part === null) {
          caveats.push("لم تسجّل الشاملة رقم جزء لهذا الموضع، فالقيمة null ولم تُخمَّن.");
        }
        if (book.verification_status !== "verified") {
          caveats.push(
            `نسبة الكتاب إلى ${MADHHAB_AR[book.madhhab]} حالتها «${book.verification_status}» ` +
              `(المصدر: ${book.classification_source}). تحقّق منها قبل الاعتماد عليها في النسبة المذهبية.`,
          );
        }
        if (tocPath.length === 0) {
          caveats.push("لا يوجد فهرس عناوين لهذا الكتاب، فمسار العنوان فارغ.");
        }

        const citation = {
          book_id: book.book_id,
          title: book.title,
          author: book.author,
          madhhab: book.madhhab,
          madhhab_ar: MADHHAB_AR[book.madhhab],
          classification_source: book.classification_source,
          verification_status: book.verification_status,
          part: page.part,
          printed_page: page.printed_page,
          page_id: page.page_id,
          toc_path: tocPath,
          edition: null,
          publisher: null,
          numbering_authority: "shamela",
          numbering_note: NUMBERING_NOTE,
          text_original: args.include_text === true ? page.text_original : null,
        };

        const locus = [
          page.part !== null ? `ج${page.part}` : null,
          page.printed_page !== null ? `ص${page.printed_page}` : null,
        ]
          .filter(Boolean)
          .join("/");

        const formatted =
          `${book.author ? `${book.author}، ` : ""}${book.title ?? book.book_id}` +
          (locus ? `، ${locus}` : "") +
          ` (معرّف الصفحة في الشاملة: ${page.page_id})` +
          (tocPath.length ? `، ضمن: ${tocPath.join(" › ")}` : "") +
          `. [${MADHHAB_AR[book.madhhab]}]` +
          ` — ${NUMBERING_NOTE}`;

        const formattedShort =
          `${book.title ?? book.book_id}${locus ? `، ${locus}` : ""}` +
          (page.printed_page === null ? ` (صفحة الشاملة ${page.page_id})` : "");

        return ok(`إحالة جاهزة: ${formattedShort}`, {
          citation,
          formatted_ar: formatted,
          formatted_short_ar: formattedShort,
          caveats_ar: caveats,
        });
      } finally {
        reader.close();
        handle.engine.close();
      }
    }),
  );
}
