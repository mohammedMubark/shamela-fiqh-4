/**
 * Batch accounting shared by every interactive tool.
 *
 * The rule this enforces: a response may be partial, but it must never be
 * *silently* partial. Whenever we stop early — because the caller's page is
 * full, because the payload got large, or because a time budget expired — the
 * response says so and hands back a cursor to continue.
 */

export type TruncationReason =
  | "none"
  | "max_results_per_response"
  | "byte_budget"
  | "time_budget"
  | "book_limit";

export const TRUNCATION_REASON_AR: Record<TruncationReason, string> = {
  none: "لم يقع أي اقتطاع.",
  max_results_per_response: "بلغت الدفعة الحد الأقصى لعدد النتائج في الاستجابة الواحدة.",
  byte_budget: "بلغت الاستجابة حد الحجم المسموح به، فأُعيدت النتائج المكتملة فقط.",
  time_budget: "انتهت المهلة المخصصة لهذه الدفعة قبل فحص جميع النتائج.",
  book_limit: "بلغت الدفعة الحد الأقصى لعدد الكتب المفحوصة في الاستجابة الواحدة.",
};

export interface BatchEnvelope {
  total_hits: number;
  returned: number;
  has_more: boolean;
  next_cursor: string | null;
  truncated: boolean;
  truncation_reason: TruncationReason;
  truncation_note_ar: string;
}

export function envelope(args: {
  totalHits: number;
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
  reason: TruncationReason;
}): BatchEnvelope {
  const truncated = args.reason !== "none";
  return {
    total_hits: args.totalHits,
    returned: args.returned,
    has_more: args.hasMore,
    next_cursor: args.nextCursor,
    truncated,
    truncation_reason: args.reason,
    truncation_note_ar: TRUNCATION_REASON_AR[args.reason],
  };
}

/** Tracks a byte budget across an incrementally built array of results. */
export class ByteBudget {
  private used = 0;
  constructor(private readonly limit: number) {}

  /** Returns false when adding this item would exceed the budget. */
  tryAdd(item: unknown): boolean {
    const size = Buffer.byteLength(JSON.stringify(item ?? null), "utf8");
    if (this.used > 0 && this.used + size > this.limit) return false;
    this.used += size;
    return true;
  }

  get bytesUsed(): number {
    return this.used;
  }
}

/** Simple wall-clock budget for a single interactive batch. */
export class TimeBudget {
  private readonly deadline: number;
  constructor(ms: number) {
    this.deadline = Date.now() + ms;
  }
  get expired(): boolean {
    return Date.now() > this.deadline;
  }
}
