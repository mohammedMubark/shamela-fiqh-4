import { readFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeArabic } from "../text/normalize.js";
import { Fiqh4Error } from "../util/errors.js";
import { packageRoot } from "../util/packageRoot.js";
import { isFile } from "../util/paths.js";
import { log } from "../util/log.js";
import { ambiguityReasons } from "./ambiguity.js";
import {
  MADHHAB_VALUES,
  type ClassifiedBook,
  type Madhhab,
  type VerificationStatus,
} from "./types.js";
import type { RawBook } from "../shamela/masterRepo.js";

/**
 * Madhhab classification.
 *
 * Precedence is fixed and auditable:
 *   1. a human-written override        → source "override",      status "verified"
 *   2. a category-name rule            → source "category_map",  status "unverified"
 *   3. nothing                         → source "unclassified"
 *
 * Title and author text can never promote a book into a madhhab; see
 * ambiguity.ts. Category *IDs* are never used — only names, normalised — because
 * IDs are not stable between Shamela installations.
 */

export interface MapRule {
  id: string;
  madhhab: Madhhab;
  match_type: "equals" | "contains";
  patterns: string[];
  reviewed: boolean;
  note_ar?: string;
}

export interface Overrides {
  overrides: Array<{ book_id: string; madhhab: Madhhab; reason?: string }>;
  include: string[];
  exclude: string[];
}

export interface ClassifierConfig {
  rules: MapRule[];
  overrides: Overrides;
  mapPath: string;
  overridesPath: string;
}

const PACKAGE_ROOT = packageRoot(import.meta.url);

export function defaultMapPath(): string {
  return join(PACKAGE_ROOT, "config", "madhhab-map.seed.json");
}

export function defaultOverridesPath(): string {
  return process.env.FIQH4_OVERRIDES_FILE?.trim() || join(PACKAGE_ROOT, "config", "madhhab-overrides.json");
}

function isMadhhab(v: unknown): v is Madhhab {
  return typeof v === "string" && (MADHHAB_VALUES as readonly string[]).includes(v);
}

function readJson(path: string, what: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Fiqh4Error(
      "OVERRIDES_INVALID",
      `تعذر قراءة ${what} من المسار ${path}: ${(e as Error).message}`,
      `Cannot read ${what} at ${path}: ${(e as Error).message}`,
      { path },
    );
  }
}

export function loadClassifierConfig(opts: { mapPath?: string; overridesPath?: string } = {}): ClassifierConfig {
  const mapPath = opts.mapPath ?? defaultMapPath();
  const overridesPath = opts.overridesPath ?? defaultOverridesPath();

  const rawMap = readJson(mapPath, "خريطة المذاهب") as { rules?: unknown };
  const rules: MapRule[] = [];
  for (const r of Array.isArray(rawMap.rules) ? rawMap.rules : []) {
    const rule = r as Partial<MapRule>;
    if (!rule.id || !isMadhhab(rule.madhhab) || !Array.isArray(rule.patterns)) continue;
    if (rule.match_type !== "equals" && rule.match_type !== "contains") continue;
    rules.push({
      id: rule.id,
      madhhab: rule.madhhab,
      match_type: rule.match_type,
      // Patterns are normalised once, at load, so the JSON can hold natural Arabic.
      patterns: rule.patterns.map((p) => normalizeArabic(String(p))).filter((p) => p.length > 0),
      reviewed: rule.reviewed === true,
      ...(rule.note_ar ? { note_ar: rule.note_ar } : {}),
    });
  }

  let overrides: Overrides = { overrides: [], include: [], exclude: [] };
  if (isFile(overridesPath)) {
    const rawOv = readJson(overridesPath, "ملف التجاوزات") as Partial<Overrides>;
    const list = Array.isArray(rawOv.overrides) ? rawOv.overrides : [];
    const bad = list.filter((o) => !o || typeof o.book_id !== "string" || !isMadhhab(o.madhhab));
    if (bad.length > 0) {
      throw new Fiqh4Error(
        "OVERRIDES_INVALID",
        `ملف التجاوزات يحتوي ${bad.length} مدخلًا غير صالح. كل مدخل يجب أن يحوي book_id نصيًا وmadhhab من القيم: ${MADHHAB_VALUES.join(", ")}.`,
        `Overrides file has ${bad.length} invalid entries; each needs a string book_id and a valid madhhab.`,
        { path: overridesPath, invalid_count: bad.length },
      );
    }
    overrides = {
      overrides: list.map((o) => ({
        book_id: String(o.book_id),
        madhhab: o.madhhab,
        ...(o.reason ? { reason: String(o.reason) } : {}),
      })),
      include: (Array.isArray(rawOv.include) ? rawOv.include : []).map(String),
      exclude: (Array.isArray(rawOv.exclude) ? rawOv.exclude : []).map(String),
    };
  } else {
    log.info("no overrides file; using category map only", { overridesPath });
  }

  return { rules, overrides, mapPath, overridesPath };
}

interface RuleHit {
  rule: MapRule;
  specificity: number;
}

/** Match a normalised category name against the rule set. `equals` outranks `contains`. */
function matchCategory(categoryNormalised: string, rules: MapRule[]): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const rule of rules) {
    for (const pattern of rule.patterns) {
      if (rule.match_type === "equals" && categoryNormalised === pattern) {
        hits.push({ rule, specificity: 2 });
        break;
      }
      if (rule.match_type === "contains" && categoryNormalised.includes(pattern)) {
        hits.push({ rule, specificity: 1 });
        break;
      }
    }
  }
  return hits.sort((a, b) => b.specificity - a.specificity);
}

export class Classifier {
  readonly config: ClassifierConfig;
  private readonly overrideById: Map<string, { madhhab: Madhhab; reason?: string }>;
  private readonly excluded: Set<string>;
  private readonly included: Set<string>;

  constructor(config: ClassifierConfig) {
    this.config = config;
    this.overrideById = new Map(config.overrides.overrides.map((o) => [o.book_id, o]));
    this.excluded = new Set(config.overrides.exclude);
    this.included = new Set(config.overrides.include);
  }

  static load(opts: { mapPath?: string; overridesPath?: string } = {}): Classifier {
    return new Classifier(loadClassifierConfig(opts));
  }

  isExcluded(bookId: string): boolean {
    return this.excluded.has(bookId);
  }

  isForceIncluded(bookId: string): boolean {
    return this.included.has(bookId);
  }

  classify(book: RawBook): ClassifiedBook {
    const base = {
      book_id: book.book_id,
      title: book.title,
      author: book.author,
      downloaded: book.downloaded,
      category: book.category,
      category_id: book.category_id,
      file_path: book.file_path,
    };

    // 1. Human override wins outright.
    const override = this.overrideById.get(book.book_id);
    if (override) {
      return {
        ...base,
        madhhab: override.madhhab,
        classification_source: "override",
        verification_status: "verified",
        ambiguity_reasons: [],
        matched_rule: null,
      };
    }

    // 2. Category name.
    const categoryNorm = normalizeArabic(book.category ?? "");
    const hits = categoryNorm ? matchCategory(categoryNorm, this.config.rules) : [];

    if (hits.length > 0) {
      const top = hits[0]!;
      const topSpecificity = top.specificity;
      const contenders = new Set(
        hits.filter((h) => h.specificity === topSpecificity).map((h) => h.rule.madhhab),
      );

      if (contenders.size > 1) {
        // Two rules of equal strength disagree — refuse to pick for the user.
        return {
          ...base,
          madhhab: "unclassified",
          classification_source: "unclassified",
          verification_status: "needs_review",
          ambiguity_reasons: [
            "conflicting_category_rules",
            ...[...contenders].sort().map((m) => `candidate:${m}`),
          ],
          matched_rule: null,
        };
      }

      const reasons = ambiguityReasons({
        title: book.title,
        author: book.author,
        assigned: top.rule.madhhab,
        assignedFrom: "category_map",
      });
      if (topSpecificity === 1) reasons.push(`partial_category_match:${top.rule.id}`);

      const status: VerificationStatus = reasons.length > 0 ? "needs_review" : "unverified";

      return {
        ...base,
        madhhab: top.rule.madhhab,
        classification_source: "category_map",
        verification_status: status,
        ambiguity_reasons: reasons,
        matched_rule: top.rule.id,
      };
    }

    // 3. Nothing matched. Hints may exist, but they do not classify.
    const reasons = ambiguityReasons({
      title: book.title,
      author: book.author,
      assigned: "unclassified",
      assignedFrom: "unclassified",
    });
    if (!book.category) reasons.push("no_category_in_catalogue");
    else reasons.push("category_not_in_map");

    return {
      ...base,
      madhhab: "unclassified",
      classification_source: "unclassified",
      verification_status: reasons.some((r) => r.includes("hint")) ? "needs_review" : "unverified",
      ambiguity_reasons: [...new Set(reasons)],
      matched_rule: null,
    };
  }

  classifyAll(books: readonly RawBook[]): ClassifiedBook[] {
    return books.filter((b) => !this.isExcluded(b.book_id)).map((b) => this.classify(b));
  }

  /** Category names present in the library that no rule covers — the review queue. */
  unmappedCategories(books: readonly ClassifiedBook[]): Array<{ category: string; book_count: number }> {
    const counts = new Map<string, number>();
    for (const b of books) {
      if (b.classification_source !== "unclassified") continue;
      const name = b.category?.trim();
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([category, book_count]) => ({ category, book_count }))
      .sort((a, b) => b.book_count - a.book_count);
  }
}
