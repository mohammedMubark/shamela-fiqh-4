import { MADHHABS, MADHHAB_AR, MADHHAB_VALUES, type ClassifiedBook, type Madhhab } from "../classify/types.js";

/**
 * What was actually searched, stated per madhhab.
 *
 * A search that quietly drops books is the failure this reports against. Books
 * leave the scope for exactly one reason on Shamela 4 — their text was never
 * downloaded, so the index holds no page of them — and until now that filtering
 * happened inside `selectBooks({ downloadedOnly: true })` and was never
 * mentioned in the response. A reader then had no way to tell "the Hanbali
 * books say nothing about this" from "none of your Hanbali books are
 * downloaded", which are opposite conclusions from the same empty result.
 *
 * So every search-shaped tool answers with this: for each school, how many of
 * its books were in scope, how many were searched, and how many were left out.
 */

export interface MadhhabCoverage {
  madhhab: Madhhab;
  madhhab_ar: string;
  books_in_scope: number;
  books_searched: number;
  books_not_downloaded: number;
}

export interface ScopeCoverage {
  /** The scope in words, so the reader need not infer it from the arguments. */
  scope_ar: string;
  madhhabs_requested: Madhhab[];
  books_in_scope: number;
  books_searched: number;
  by_madhhab: MadhhabCoverage[];
  /** A sample of what was left out; `books_not_downloaded_total` is the true count. */
  books_not_downloaded: Array<{ book_id: string; title: string | null; madhhab: Madhhab }>;
  books_not_downloaded_total: number;
  note_ar: string;
}

/** How many excluded books to name. The total is always exact regardless. */
const LIST_LIMIT = 20;

/** True when the request covers exactly the four schools and nothing else. */
function isFourMadhhabs(requested: readonly Madhhab[]): boolean {
  const set = new Set(requested);
  return set.size === MADHHABS.length && MADHHABS.every((m) => set.has(m));
}

function describeScope(requested: readonly Madhhab[], byBookId: boolean): string {
  if (byBookId) return "كتب محددة بمعرّفاتها.";
  if (isFourMadhhabs(requested)) return "كل كتب المذاهب الأربعة المنزَّلة في المكتبة.";
  if (requested.length === 0) return "كل كتب المكتبة المنزَّلة.";
  return `المذاهب المطلوبة: ${requested.map((m) => MADHHAB_AR[m]).join("، ")}.`;
}

export interface CoverageInput {
  /** Every book the scope resolved to, downloaded or not. */
  books: ClassifiedBook[];
  /** The madhhabs the caller asked for, after the default has been applied. */
  requested?: readonly Madhhab[] | undefined;
  /** True when the caller named book ids, so the madhhab filter did not apply. */
  byBookId?: boolean;
}

export function buildCoverage(input: CoverageInput): ScopeCoverage {
  const { books } = input;
  // Tolerated rather than required at runtime: scripts and the bench drive
  // these pipelines from plain JavaScript, where a missing field is a crash
  // rather than a type error, and a coverage report is never worth one.
  const requested: readonly Madhhab[] = input.requested ?? [];
  const searched = books.filter((b) => b.downloaded);
  const missing = books.filter((b) => !b.downloaded);

  // Report a row for every school asked about, including one that contributed
  // nothing: a zero that is printed is information, a zero that is omitted
  // reads as if the school was never in scope.
  const rowsFor = new Set<Madhhab>([
    ...requested,
    ...books.map((b) => b.madhhab),
  ]);

  const by_madhhab = MADHHAB_VALUES.filter((m) => rowsFor.has(m)).map((m) => {
    const inScope = books.filter((b) => b.madhhab === m);
    const downloaded = inScope.filter((b) => b.downloaded).length;
    return {
      madhhab: m,
      madhhab_ar: MADHHAB_AR[m],
      books_in_scope: inScope.length,
      books_searched: downloaded,
      books_not_downloaded: inScope.length - downloaded,
    };
  });

  const emptySchools = by_madhhab.filter((r) => r.books_searched === 0).map((r) => r.madhhab_ar);

  return {
    scope_ar: describeScope(requested, input.byBookId === true),
    madhhabs_requested: [...requested],
    books_in_scope: books.length,
    books_searched: searched.length,
    by_madhhab,
    books_not_downloaded: missing.slice(0, LIST_LIMIT).map((b) => ({
      book_id: b.book_id,
      title: b.title,
      madhhab: b.madhhab,
    })),
    books_not_downloaded_total: missing.length,
    note_ar:
      `بُحث في ${searched.length} كتابًا من ${books.length} في النطاق.` +
      (missing.length > 0
        ? ` استُبعد ${missing.length} كتابًا لأن نصّه غير مُنزَّل في الشاملة، فلا صفحة له في الفهرس؛ نزّله من داخل برنامج الشاملة ليدخل البحث.`
        : " لم يُستبعد أي كتاب.") +
      (emptySchools.length > 0
        ? ` تنبيه: لا كتاب مُنزَّل أصلًا في ${emptySchools.join("، ")}، فخلوّها من النتائج راجع إلى التغطية لا إلى النصوص.`
        : ""),
  };
}
