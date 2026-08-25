import { Fiqh4Error } from "../util/errors.js";

/**
 * Opaque pagination cursors.
 *
 * A cursor carries the position to resume from *and* the identity of Shamela's
 * Lucene index and query it was issued against. If either changed — Shamela's
 * index commit moved, the normaliser version was bumped, the user edited the query — the
 * cursor is rejected with CURSOR_STALE rather than silently resuming against
 * different data, which would drop or duplicate results without telling anyone.
 */

export const CURSOR_VERSION = 3;

export interface AfterKey {
  /** Relevance score of the last returned hit. */
  score: number;
  /** Engine-local document id of the last returned hit; breaks score ties. */
  doc: number;
}

export interface CursorPayload {
  v: number;
  /** Index fingerprint: engine + normaliser + book set + Shamela Lucene commit. */
  fp: string;
  /** Query hash: mode + normalised terms. */
  qh: string;
  after: AfterKey;
  /** How many hits have already been delivered — echoed back for the caller. */
  delivered: number;
  /**
   * Exact total for this query, carried from the first batch.
   *
   * Recomputing it per batch costs a full pass over the match set every time,
   * which dominates paging on large results. It is safe to carry because the
   * fingerprint pins the Lucene commit: a cursor whose index changed is rejected
   * outright, so the total it was issued with cannot have gone stale.
   */
  total: number;
}

export function encodeCursor(p: CursorPayload): string {
  return Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
}

export function decodeCursor(raw: string, expected: { fp: string; qh: string }): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Fiqh4Error(
      "CURSOR_INVALID",
      "المؤشر (cursor) غير صالح أو تالف. أعد تنفيذ البحث من البداية بدون cursor.",
      "Cursor is not decodable.",
      {},
    );
  }

  const p = parsed as Partial<CursorPayload>;
  if (
    typeof p !== "object" ||
    p === null ||
    typeof p.v !== "number" ||
    typeof p.fp !== "string" ||
    typeof p.qh !== "string" ||
    typeof p.after !== "object" ||
    p.after === null ||
    typeof (p.after as AfterKey).score !== "number" ||
    typeof (p.after as AfterKey).doc !== "number"
  ) {
    throw new Fiqh4Error(
      "CURSOR_INVALID",
      "بنية المؤشر (cursor) غير متوقعة. أعد تنفيذ البحث من البداية بدون cursor.",
      "Cursor payload has an unexpected shape.",
      {},
    );
  }

  if (p.v !== CURSOR_VERSION) {
    throw new Fiqh4Error(
      "CURSOR_STALE",
      `المؤشر صادر عن إصدار أقدم (${p.v}) من صيغة المؤشرات (${CURSOR_VERSION}). أعد تنفيذ البحث من البداية.`,
      `Cursor version ${p.v} != ${CURSOR_VERSION}.`,
      { cursor_version: p.v, expected_version: CURSOR_VERSION },
    );
  }

  if (p.fp !== expected.fp) {
    throw new Fiqh4Error(
      "CURSOR_STALE",
      "تغيّرت بصمة فهرس الشاملة بعد إصدار هذا المؤشر (تغيّر commit فهرس Lucene أو تغيّرت الكتب المختارة أو إصدار التطبيع). أعد تنفيذ البحث من البداية للحصول على نتائج متسقة.",
      "Cursor was issued against a different index fingerprint.",
      { cursor_fingerprint: p.fp, current_fingerprint: expected.fp },
    );
  }

  if (p.qh !== expected.qh) {
    throw new Fiqh4Error(
      "CURSOR_STALE",
      "المؤشر صادر عن استعلام مختلف (تغيّر النص أو نمط المطابقة). أعد تنفيذ البحث من البداية.",
      "Cursor was issued against a different query.",
      { cursor_query: p.qh, current_query: expected.qh },
    );
  }

  return {
    v: p.v,
    fp: p.fp,
    qh: p.qh,
    after: { score: (p.after as AfterKey).score, doc: (p.after as AfterKey).doc },
    delivered: typeof p.delivered === "number" ? p.delivered : 0,
    total: typeof p.total === "number" ? p.total : -1,
  };
}
