/**
 * stdout is reserved for the MCP JSON-RPC stream, so every log line goes to
 * stderr. Anything else corrupts the protocol.
 */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 } as const;
export type LogLevel = keyof typeof LEVELS;

function currentLevel(): number {
  const raw = (process.env.FIQH4_LOG_LEVEL ?? "warn").toLowerCase();
  return LEVELS[raw as LogLevel] ?? LEVELS.warn;
}

function emit(level: LogLevel, msg: string, extra?: unknown): void {
  if (LEVELS[level] > currentLevel()) return;
  const line = `[shamela-fiqh-4] ${level.toUpperCase()} ${msg}`;
  process.stderr.write(extra === undefined ? `${line}\n` : `${line} ${safeJson(extra)}\n`);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export const log = {
  error: (m: string, x?: unknown) => emit("error", m, x),
  warn: (m: string, x?: unknown) => emit("warn", m, x),
  info: (m: string, x?: unknown) => emit("info", m, x),
  debug: (m: string, x?: unknown) => emit("debug", m, x),
};
