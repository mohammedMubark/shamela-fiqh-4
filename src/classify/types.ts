/** The only madhhab values this extension will ever emit. */
export const MADHHABS = ["hanafi", "maliki", "shafii", "hanbali"] as const;
export const MADHHAB_VALUES = [...MADHHABS, "comparative", "unclassified"] as const;

export type Madhhab = (typeof MADHHAB_VALUES)[number];
export type CoreMadhhab = (typeof MADHHABS)[number];

export const MADHHAB_AR: Record<Madhhab, string> = {
  hanafi: "الحنفي",
  maliki: "المالكي",
  shafii: "الشافعي",
  hanbali: "الحنبلي",
  comparative: "الفقه المقارن",
  unclassified: "غير مُصنَّف",
};

export type ClassificationSource = "override" | "category_map" | "unclassified";
export type VerificationStatus = "verified" | "needs_review" | "unverified";

export interface ClassifiedBook {
  book_id: string;
  title: string | null;
  author: string | null;
  madhhab: Madhhab;
  downloaded: boolean;
  category: string | null;
  category_id: string | null;
  classification_source: ClassificationSource;
  verification_status: VerificationStatus;
  /** Machine-readable reasons a human should look at this row. */
  ambiguity_reasons: string[];
  /** Which map rule fired, when one did. */
  matched_rule: string | null;
  file_path: string | null;
}
