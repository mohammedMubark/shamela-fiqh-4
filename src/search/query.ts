import { createHash } from "node:crypto";
import { normalizeArabic, tokenize, NORMALIZER_VERSION } from "../text/normalize.js";
import { Fiqh4Error } from "../util/errors.js";

/**
 * Query construction.
 *
 * The user's query goes through exactly the same normaliser as the indexed
 * text, so "الصَّلَاة" and "الصلاه" are the same query. Tokens are quoted
 * individually when handed to FTS5 so nothing in the user's input can be read
 * as FTS operator syntax.
 */

export type MatchMode = "phrase" | "all_terms" | "any_terms";
export const MATCH_MODES: MatchMode[] = ["phrase", "all_terms", "any_terms"];

export const MATCH_MODE_AR: Record<MatchMode, string> = {
  phrase: "عبارة متتابعة بالترتيب",
  all_terms: "جميع الكلمات في الصفحة نفسها",
  any_terms: "أي كلمة من الكلمات",
};

export interface ParsedQuery {
  /** What the user typed, untouched — echoed back in results. */
  raw: string;
  mode: MatchMode;
  /** Normalised tokens actually searched for. */
  terms: string[];
  /** FTS5 MATCH expression. */
  ftsExpression: string;
  /** Stable hash over (mode, terms, normaliser) — binds cursors to this query. */
  hash: string;
}

/** Quote a token as an FTS5 string literal; doubles any embedded quote. */
function ftsQuote(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

export function parseQuery(raw: string, mode: MatchMode): ParsedQuery {
  const terms = tokenize(normalizeArabic(raw));
  if (terms.length === 0) {
    throw new Fiqh4Error(
      "INVALID_QUERY",
      "الاستعلام فارغ بعد التطبيع: لم يبق فيه أي كلمة قابلة للبحث. اكتب كلمة أو عبارة عربية.",
      "Query contains no searchable tokens after normalisation.",
      { raw },
    );
  }

  const quoted = terms.map(ftsQuote);
  let ftsExpression: string;
  switch (mode) {
    case "phrase":
      // FTS5 phrase: consecutive quoted tokens joined by '+' must appear in order.
      ftsExpression = quoted.join(" + ");
      break;
    case "all_terms":
      ftsExpression = quoted.join(" AND ");
      break;
    case "any_terms":
      ftsExpression = quoted.join(" OR ");
      break;
  }

  const hash = createHash("sha256")
    .update(JSON.stringify({ mode, terms, normalizer: NORMALIZER_VERSION }))
    .digest("hex")
    .slice(0, 16);

  return { raw, mode, terms, ftsExpression, hash };
}

/**
 * Why this page matched, stated in Arabic and grounded in the page's own text.
 * Reports which of the query terms were actually found rather than asserting a
 * relevance judgement.
 */
export function matchReason(query: ParsedQuery, normalisedPageText: string): string {
  if (query.mode === "phrase") {
    const phrase = query.terms.join(" ");
    return normalisedPageText.includes(phrase)
      ? `العبارة «${query.raw.trim()}» وردت متتابعة في الصفحة.`
      : `طابقت الصفحة عبارة البحث في الفهرس، وتعذّر تأكيد تتابعها في النص المقروء.`;
  }
  const found = query.terms.filter((t) => normalisedPageText.includes(t));
  const missing = query.terms.filter((t) => !normalisedPageText.includes(t));
  if (query.mode === "all_terms") {
    return `وردت جميع كلمات البحث في الصفحة (${found.length}/${query.terms.length}): ${found.join("، ")}.`;
  }
  return missing.length === 0
    ? `وردت كل الكلمات المطلوبة: ${found.join("، ")}.`
    : `وردت الكلمات: ${found.join("، ")}${missing.length ? ` — ولم ترد: ${missing.join("، ")}` : ""}.`;
}

/** First character offset of a match inside normalised text, or -1. */
export function firstMatchOffset(query: ParsedQuery, normalisedPageText: string): number {
  if (query.mode === "phrase") {
    const at = normalisedPageText.indexOf(query.terms.join(" "));
    if (at >= 0) return at;
  }
  let best = -1;
  for (const t of query.terms) {
    const at = normalisedPageText.indexOf(t);
    if (at >= 0 && (best === -1 || at < best)) best = at;
  }
  return best;
}
