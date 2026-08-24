import { normalizeArabic } from "../text/normalize.js";
import { MADHHABS, type CoreMadhhab } from "./types.js";

/**
 * Title and author hints.
 *
 * These NEVER assign a madhhab. A book called «الفقه الشافعي» might be a
 * refutation of it, and an author called الشافعي is not evidence about the book
 * in hand. Hints exist only to flag rows a human should look at, which is why
 * every function here returns reasons rather than a classification.
 */

const HINT_PATTERNS: Record<CoreMadhhab, string[]> = {
  hanafi: ["حنفي", "حنفيه", "الاحناف", "ابو حنيفه"],
  maliki: ["مالكي", "مالكيه", "المالكيه", "مالك بن انس"],
  shafii: ["شافعي", "شافعيه", "الشافعيه"],
  hanbali: ["حنبلي", "حنبليه", "الحنابله", "ابن حنبل", "احمد بن حنبل"],
};

const NORMALISED: Array<{ madhhab: CoreMadhhab; needles: string[] }> = MADHHABS.map((m) => ({
  madhhab: m,
  needles: HINT_PATTERNS[m].map(normalizeArabic),
}));

/** Madhhabs merely *hinted at* by a free-text field. */
export function hintsIn(text: string | null | undefined): CoreMadhhab[] {
  if (!text) return [];
  const hay = normalizeArabic(text);
  if (!hay) return [];
  return NORMALISED.filter(({ needles }) => needles.some((n) => n.length > 0 && hay.includes(n))).map(
    (x) => x.madhhab,
  );
}

/**
 * Build ambiguity reasons for one book.
 * `assigned` is whatever the category map or an override decided, so hints can
 * be compared against it rather than substituted for it.
 */
export function ambiguityReasons(args: {
  title: string | null;
  author: string | null;
  assigned: string;
  assignedFrom: "override" | "category_map" | "unclassified";
}): string[] {
  const reasons: string[] = [];
  const titleHints = hintsIn(args.title);
  const authorHints = hintsIn(args.author);

  if (args.assignedFrom === "unclassified") {
    // Hints without a category are exactly the rows a human must adjudicate.
    for (const h of titleHints) reasons.push(`title_hint_only:${h}`);
    for (const h of authorHints) reasons.push(`author_hint_only:${h}`);
    const distinct = new Set([...titleHints, ...authorHints]);
    if (distinct.size > 1) reasons.push("conflicting_hints");
  } else if (args.assignedFrom === "category_map") {
    // A hint pointing somewhere else than the category is worth a second look.
    for (const h of titleHints) if (h !== args.assigned) reasons.push(`title_hint_conflicts:${h}`);
    for (const h of authorHints) if (h !== args.assigned) reasons.push(`author_hint_conflicts:${h}`);
  }

  return [...new Set(reasons)];
}
