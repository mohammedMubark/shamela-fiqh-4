/**
 * Typed, bilingual errors. Every failure the user can trigger gets a stable
 * machine `code` plus an Arabic message, so tools never fail with a bare stack.
 */

export type Fiqh4ErrorCode =
  | "SHAMELA_DIR_MISSING"
  | "SHAMELA_DIR_UNREADABLE"
  | "MASTER_DB_MISSING"
  | "SCHEMA_UNRECOGNISED"
  | "BOOK_NOT_FOUND"
  | "BOOK_NOT_DOWNLOADED"
  | "BOOK_UNREADABLE"
  | "INDEX_MISSING"
  | "INDEX_STALE"
  | "CURSOR_INVALID"
  | "CURSOR_STALE"
  | "UNSAFE_OUTPUT_PATH"
  | "WRITE_INTO_SHAMELA_DIR"
  | "ENGINE_UNAVAILABLE"
  | "INVALID_QUERY"
  | "OVERRIDES_INVALID"
  | "CHECKPOINT_MISMATCH";

export class Fiqh4Error extends Error {
  readonly code: Fiqh4ErrorCode;
  readonly messageAr: string;
  readonly details: Record<string, unknown>;

  constructor(
    code: Fiqh4ErrorCode,
    messageAr: string,
    messageEn: string,
    details: Record<string, unknown> = {},
  ) {
    super(`${code}: ${messageEn}`);
    this.name = "Fiqh4Error";
    this.code = code;
    this.messageAr = messageAr;
    this.details = details;
  }

  toStructured(): {
    ok: false;
    error: { code: Fiqh4ErrorCode; message_ar: string; message_en: string; details: Record<string, unknown> };
  } {
    return {
      ok: false,
      error: {
        code: this.code,
        message_ar: this.messageAr,
        message_en: this.message.slice(this.code.length + 2),
        details: this.details,
      },
    };
  }
}

export function isFiqh4Error(e: unknown): e is Fiqh4Error {
  return e instanceof Fiqh4Error;
}

/** Wrap any thrown value into a Fiqh4Error-shaped structured payload. */
export function toStructuredError(e: unknown): ReturnType<Fiqh4Error["toStructured"]> {
  if (isFiqh4Error(e)) return e.toStructured();
  const msg = e instanceof Error ? e.message : String(e);
  return {
    ok: false,
    error: {
      code: "SCHEMA_UNRECOGNISED",
      message_ar: `خطأ غير متوقع: ${msg}`,
      message_en: msg,
      details: {},
    },
  };
}
