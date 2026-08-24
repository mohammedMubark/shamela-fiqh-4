import { describe, expect, it } from "vitest";
import { CURSOR_VERSION, decodeCursor, encodeCursor } from "../../src/search/cursor.js";
import { Fiqh4Error } from "../../src/util/errors.js";

const FP = "fingerprint-aaa";
const QH = "queryhash-bbb";

function make(over: Partial<Parameters<typeof encodeCursor>[0]> = {}): string {
  return encodeCursor({
    v: CURSOR_VERSION,
    fp: FP,
    qh: QH,
    after: { score: 1.25, doc: 42 },
    delivered: 10,
    total: 500,
    ...over,
  });
}

describe("cursor", () => {
  it("round-trips a position", () => {
    const decoded = decodeCursor(make(), { fp: FP, qh: QH });
    expect(decoded.after).toEqual({ score: 1.25, doc: 42 });
    expect(decoded.delivered).toBe(10);
  });

  it("carries the exact total forward so later batches need not recount", () => {
    expect(decodeCursor(make(), { fp: FP, qh: QH }).total).toBe(500);
  });

  it("is opaque base64url — no padding, URL-safe alphabet", () => {
    expect(make()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("preserves float scores exactly, since keyset paging compares them", () => {
    const score = 0.1 + 0.2;
    const decoded = decodeCursor(make({ after: { score, doc: 7 } }), { fp: FP, qh: QH });
    expect(decoded.after.score).toBe(score);
  });

  // ── the whole point: a cursor must not survive the data changing ──────────
  it("is rejected when the index fingerprint changed (reindex)", () => {
    expect(() => decodeCursor(make(), { fp: "different", qh: QH })).toThrow(Fiqh4Error);
    try {
      decodeCursor(make(), { fp: "different", qh: QH });
    } catch (e) {
      expect((e as Fiqh4Error).code).toBe("CURSOR_STALE");
      expect((e as Fiqh4Error).messageAr).toContain("تغيّر فهرس البحث");
    }
  });

  it("is rejected when the query changed", () => {
    try {
      decodeCursor(make(), { fp: FP, qh: "other-query" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Fiqh4Error).code).toBe("CURSOR_STALE");
    }
  });

  it("is rejected when the cursor format version is older", () => {
    try {
      decodeCursor(make({ v: CURSOR_VERSION - 1 }), { fp: FP, qh: QH });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Fiqh4Error).code).toBe("CURSOR_STALE");
    }
  });

  it("reports a garbage cursor as invalid, not stale", () => {
    for (const bad of ["not-base64!!", "", Buffer.from("{}", "utf8").toString("base64url")]) {
      try {
        decodeCursor(bad, { fp: FP, qh: QH });
        throw new Error(`should have thrown for ${JSON.stringify(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(Fiqh4Error);
        expect((e as Fiqh4Error).code).toBe("CURSOR_INVALID");
      }
    }
  });

  it("rejects a structurally valid payload missing the after key", () => {
    const raw = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, fp: FP, qh: QH }), "utf8").toString(
      "base64url",
    );
    try {
      decodeCursor(raw, { fp: FP, qh: QH });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Fiqh4Error).code).toBe("CURSOR_INVALID");
    }
  });

  it("never silently resets to the beginning", () => {
    // A stale cursor must raise; returning page 1 instead would duplicate rows
    // the caller has already seen without any signal that it happened.
    expect(() => decodeCursor(make(), { fp: "changed", qh: QH })).toThrow();
  });
});
