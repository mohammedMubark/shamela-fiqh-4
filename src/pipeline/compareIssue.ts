import type { Madhhab } from "../classify/types.js";
import { MADHHAB_AR, MADHHAB_VALUES } from "../classify/types.js";
import type { Passage } from "./passage.js";
import type { BatchEnvelope } from "./batching.js";

/**
 * Grouping evidence for comparison.
 *
 * This function deliberately has no notion of a ruling, a preponderant view, or
 * a consensus. It sorts attributed quotations into buckets and reports what is
 * and is not covered; deciding what the passages *mean* is the reader's work,
 * and a tool that guessed at it would be manufacturing fiqh from search hits.
 *
 * That is a structural guarantee, not a matter of prompt wording: the output
 * type has no field a ruling could be written into.
 */

export const COMPARISON_DISCLAIMER =
  "هذه الأداة تجمع النصوص وتنسبها إلى مصادرها فقط. لا تُصدر حكمًا فقهيًا، ولا ترجّح بين الأقوال، " +
  "ولا تُثبت إجماعًا. غياب مذهب من النتائج يعني غياب مطابقة نصية في الكتب المفهرسة، لا خلوّ المذهب من قول. " +
  "راجِع النصوص في مواضعها وارجع إلى أهل العلم في الاستنباط والترجيح.";

export interface BookEvidence {
  book_id: string;
  title: string | null;
  author: string | null;
  classification_source: string;
  verification_status: string;
  passages: Passage[];
}

export interface MadhhabGroup {
  madhhab: Madhhab;
  madhhab_ar: string;
  books_count: number;
  passages_count: number;
  books: BookEvidence[];
  /** Stated plainly when a school produced nothing, so silence is not read as absence of a view. */
  coverage_note_ar: string;
}

export interface ComparisonResult {
  query: string;
  match_mode: string;
  groups: MadhhabGroup[];
  summary: {
    madhhabs_with_evidence: Madhhab[];
    madhhabs_without_evidence: Madhhab[];
    total_passages: number;
    total_books: number;
  };
  disclaimer_ar: string;
  batch?: BatchEnvelope;
}

export interface CompareInput {
  query: string;
  matchMode: string;
  passages: Passage[];
  /** Which madhhabs the user asked about — drives the "no evidence" reporting. */
  requested: Madhhab[];
}

export function compareIssue(input: CompareInput): ComparisonResult {
  const byMadhhab = new Map<Madhhab, Map<string, BookEvidence>>();

  for (const p of input.passages) {
    let books = byMadhhab.get(p.madhhab);
    if (!books) {
      books = new Map();
      byMadhhab.set(p.madhhab, books);
    }
    let entry = books.get(p.book_id);
    if (!entry) {
      entry = {
        book_id: p.book_id,
        title: p.title,
        author: p.author,
        classification_source: p.classification_source,
        verification_status: p.verification_status,
        passages: [],
      };
      books.set(p.book_id, entry);
    }
    entry.passages.push(p);
  }

  const order = MADHHAB_VALUES.filter(
    (m) => byMadhhab.has(m) || input.requested.includes(m),
  );

  const groups: MadhhabGroup[] = order.map((madhhab) => {
    const books = [...(byMadhhab.get(madhhab)?.values() ?? [])].sort(
      (a, b) => b.passages.length - a.passages.length,
    );
    const passagesCount = books.reduce((n, b) => n + b.passages.length, 0);
    return {
      madhhab,
      madhhab_ar: MADHHAB_AR[madhhab],
      books_count: books.length,
      passages_count: passagesCount,
      books,
      coverage_note_ar:
        passagesCount > 0
          ? `وُجدت ${passagesCount} مواضع في ${books.length} كتاب من الكتب المفهرسة المنسوبة إلى ${MADHHAB_AR[madhhab]}.`
          : `لم تُطابق أي صفحة في الكتب المفهرسة المنسوبة إلى ${MADHHAB_AR[madhhab]}. هذا نتيجة بحث نصي، وليس نفيًا لوجود قول في المذهب.`,
    };
  });

  const withEvidence = groups.filter((g) => g.passages_count > 0).map((g) => g.madhhab);
  const withoutEvidence = groups.filter((g) => g.passages_count === 0).map((g) => g.madhhab);

  return {
    query: input.query,
    match_mode: input.matchMode,
    groups,
    summary: {
      madhhabs_with_evidence: withEvidence,
      madhhabs_without_evidence: withoutEvidence,
      total_passages: input.passages.length,
      total_books: new Set(input.passages.map((p) => p.book_id)).size,
    },
    disclaimer_ar: COMPARISON_DISCLAIMER,
  };
}
