import { z } from "zod";
import { MADHHAB_VALUES } from "../classify/types.js";
import { MATCH_MODES } from "../search/query.js";
import { toStructuredError } from "../util/errors.js";

/**
 * Shared Zod fragments and result builders.
 *
 * Every tool answers with a short Arabic summary in `content` plus the machine
 * payload in `structuredContent`. Nested objects are declared `.passthrough()`
 * so adding a descriptive field never turns into a runtime validation failure
 * for a user mid-search — the required keys are exactly the ones every code
 * path emits.
 */

/** The error payload every tool may return in place of its success shape. */
export const zError = z
  .object({
    code: z.string(),
    message_ar: z.string(),
    message_en: z.string(),
    details: z.record(z.unknown()).optional(),
  })
  .passthrough();

/**
 * Build a tool's declared output schema.
 *
 * Two constraints shape this. MCP clients validate `structuredContent` against
 * the declared schema whenever it is present — including on error responses —
 * so a strict success-only schema would make every typed error a protocol
 * failure, and we would have to drop machine-readable error codes to avoid it.
 * And responses carry descriptive extras (Arabic labels, settings echoes) that a
 * closed schema would reject.
 *
 * So: `ok` is the required discriminant, `error` is always permitted, the
 * success fields are declared (with their descriptions intact, which is what
 * actually documents the payload to a model) but optional, and unknown keys
 * pass through.
 */
export function outputSchema<T extends z.ZodRawShape>(shape: T) {
  const optional: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(shape)) {
    optional[key] = (value as z.ZodTypeAny).optional();
  }
  return z
    .object({ ok: z.boolean(), error: zError.optional(), ...optional })
    .passthrough();
}

export const zMadhhab = z.enum(MADHHAB_VALUES as unknown as [string, ...string[]]);
export const zMatchMode = z.enum(MATCH_MODES as unknown as [string, ...string[]]);

export const zBatch = z
  .object({
    total_hits: z.number(),
    total_hits_exact: z.boolean(),
    returned: z.number(),
    has_more: z.boolean(),
    next_cursor: z.string().nullable(),
    truncated: z.boolean(),
    truncation_reason: z.enum([
      "none",
      "max_results_per_response",
      "byte_budget",
      "time_budget",
      "book_limit",
      "scan_limit",
    ]),
    truncation_note_ar: z.string(),
  })
  .passthrough();

export const zPassage = z
  .object({
    book_id: z.string(),
    title: z.string().nullable(),
    author: z.string().nullable(),
    madhhab: zMadhhab,
    page_id: z.number(),
    part: z.string().nullable(),
    printed_page: z.number().nullable(),
    toc_path: z.array(z.string()),
    score: z.number(),
    match_reason: z.string(),
    text_original: z.string(),
    excerpt: z.string(),
  })
  .passthrough();

/**
 * What holds for every passage in a response.
 *
 * These used to sit inside each passage, where they said the same thing fifty
 * times over and cost the reader thousands of tokens for one sentence's worth
 * of information. `applies_to_ar` states their scope so nothing is lost by
 * moving them up here.
 */
export const zPassageNotes = z
  .object({
    query: z.string(),
    match_mode: z.string(),
    numbering_note_ar: z.string(),
    content_trust: z.literal("untrusted_source_text"),
    applies_to_ar: z.string(),
  })
  .passthrough();

/** Which books were searched, per madhhab, and what was left out and why. */
export const zCoverage = z
  .object({
    scope_ar: z.string(),
    madhhabs_requested: z.array(zMadhhab),
    books_in_scope: z.number(),
    books_searched: z.number(),
    by_madhhab: z.array(z.object({}).passthrough()),
    books_not_downloaded: z.array(z.object({}).passthrough()),
    books_not_downloaded_total: z.number(),
    note_ar: z.string(),
  })
  .passthrough();

export const zBook = z
  .object({
    book_id: z.string(),
    title: z.string().nullable(),
    author: z.string().nullable(),
    madhhab: zMadhhab,
    downloaded: z.boolean(),
    category: z.string().nullable(),
    classification_source: z.enum(["override", "category_map", "unclassified"]),
    verification_status: z.enum(["verified", "needs_review", "unverified"]),
    ambiguity_reasons: z.array(z.string()),
  })
  .passthrough();

/** Standard scope arguments, reused by every search-shaped tool. */
export const scopeShape = {
  madhhabs: z
    .array(zMadhhab)
    .optional()
    .describe(
      "المذاهب المطلوب البحث فيها. الافتراضي عند تركه فارغًا: المذاهب الأربعة كلها " +
        "(hanafi, maliki, shafii, hanbali). لتوسيع النطاق مرّر comparative أو unclassified صراحةً.",
    ),
  book_ids: z
    .array(z.string())
    .optional()
    .describe("معرّفات كتب محددة. عند تمريرها تتجاهل الأداةُ فلترَ المذاهب وتبحث في هذه الكتب فقط."),
};

export interface ToolOk {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
  /** The SDK's CallToolResult allows extra keys; this keeps the shapes compatible. */
  [k: string]: unknown;
}

/** Success: an Arabic summary for the reader, the payload for the caller. */
export function ok(summaryAr: string, structured: Record<string, unknown>): ToolOk {
  return {
    content: [{ type: "text", text: summaryAr }],
    structuredContent: { ok: true, ...structured },
  };
}

/**
 * Failure. `isError` is set, which also tells the SDK to skip output-schema
 * validation — an error payload deliberately has a different shape.
 */
export function fail(e: unknown): ToolOk {
  const payload = toStructuredError(e);
  return {
    content: [{ type: "text", text: `تعذّر تنفيذ الطلب: ${payload.error.message_ar}` }],
    structuredContent: payload as unknown as Record<string, unknown>,
    isError: true,
  };
}

/** Wrap a handler so no exception escapes as an untyped protocol error. */
export function guard<A>(fn: (args: A) => Promise<ToolOk>): (args: A) => Promise<ToolOk> {
  return async (args: A) => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

export function clampLimit(requested: number | undefined, fallback: number, max: number): number {
  const n = requested ?? fallback;
  return Math.max(1, Math.min(max, Math.floor(n)));
}
