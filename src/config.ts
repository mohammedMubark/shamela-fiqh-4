/**
 * Every environment variable this server reads, and the one rule that makes
 * them safe to read.
 *
 * MCPB substitutes `user_config` values into the environment before launching
 * the process. Two of its behaviours have to be handled here, because handling
 * them at each call site is exactly what went wrong before:
 *
 *   1. A setting the user left alone arrives as an **empty string**, not as an
 *      absent variable. "Set to empty" and "not set" mean the same thing to us.
 *   2. A field declared without a `default` in manifest.json is missing from the
 *      client's settings file entirely, so its placeholder is never substituted
 *      and the literal text `${user_config.java_path}` arrives as the value.
 *
 * Case 2 is the worse one: a non-empty string that names no file. Code that
 * treats any non-empty value as an explicit user choice then honours a path
 * that cannot exist — which disabled Java discovery outright, and silently
 * redirected the overrides file and the export directory. `cleaned()` drops
 * both shapes so a call site sees `undefined`, exactly as if the user had never
 * touched the setting.
 *
 * Values are read on every call, never cached at import time: tests and
 * `fiqh4_health({refresh:true})` change the environment after this module is
 * loaded and expect the change to take effect.
 *
 * This module imports nothing from the rest of src/ — util/log.ts depends on it
 * for the log level, so a dependency in the other direction would be a cycle.
 */

/** An MCPB placeholder that was never substituted, e.g. `${user_config.java_path}`. */
const UNRESOLVED_PLACEHOLDER = /^\$\{[^}]*\}$/;

/**
 * Normalise one configured string to "the user actually chose this" or `undefined`.
 *
 * Exported because it states the rule, and the rule is what the tests pin.
 */
export function cleaned(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (UNRESOLVED_PLACEHOLDER.test(trimmed)) return undefined;
  return trimmed;
}

/** Read one variable through `cleaned`. */
export function envText(name: string): string | undefined {
  return cleaned(process.env[name]);
}

/**
 * Read a bounded integer. Anything unparsable — including an unresolved
 * placeholder — falls back rather than failing, because a bad batch size is
 * never a reason to refuse a search.
 */
export function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = envText(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** The Shamela installation root, when the user named one. */
export const shamelaDir = (): string | undefined => envText("FIQH4_SHAMELA_DIR");

/** A Java the user chose in preference to the one Shamela ships. */
export const javaPath = (): string | undefined => envText("FIQH4_JAVA_PATH");

/** The only directory exports may be written to, when overridden. */
export const outputDir = (): string | undefined => envText("FIQH4_OUTPUT_DIR");

/** A user-supplied madhhab overrides file, replacing the shipped one. */
export const overridesFile = (): string | undefined => envText("FIQH4_OVERRIDES_FILE");

/** Reserved for derived artefacts; this build queries Shamela's index directly. */
export const indexDir = (): string | undefined => envText("FIQH4_INDEX_DIR");

/** Where `npm run build:java` put the helper classes, when relocated. */
export const helperClasses = (): string | undefined => envText("FIQH4_HELPER_CLASSES");

/** Raw log level text; util/log.ts owns validating it. */
export const logLevel = (): string | undefined => envText("FIQH4_LOG_LEVEL");

/** Every variable that reaches this server from `user_config`. */
export const CONFIG_ENV_VARS = [
  "FIQH4_SHAMELA_DIR",
  "FIQH4_JAVA_PATH",
  "FIQH4_OUTPUT_DIR",
  "FIQH4_OVERRIDES_FILE",
  "FIQH4_INDEX_DIR",
  "FIQH4_HELPER_CLASSES",
  "FIQH4_MAX_RESULTS_PER_RESPONSE",
  "FIQH4_MAX_RESPONSE_BYTES",
  "FIQH4_CONCURRENCY",
  "FIQH4_LOG_LEVEL",
] as const;

export interface EnvReportEntry {
  name: string;
  /** `set` · `empty` (treated as unset) · `unresolved_placeholder` · `unset`. */
  state: "set" | "empty" | "unresolved_placeholder" | "unset";
  /** The value in force, or `null` when the variable is being ignored. */
  value: string | null;
}

/**
 * What this process actually received, for `fiqh4_health`.
 *
 * The bug this module exists to prevent was invisible from inside the server:
 * the failure said "no Java found" while the real cause was a placeholder in an
 * environment variable nobody could see. Reporting the received state turns
 * that class of problem into one health call.
 */
export function envReport(): EnvReportEntry[] {
  return CONFIG_ENV_VARS.map((name) => {
    const raw = process.env[name];
    if (raw === undefined) return { name, state: "unset" as const, value: null };
    const trimmed = raw.trim();
    if (!trimmed) return { name, state: "empty" as const, value: null };
    if (UNRESOLVED_PLACEHOLDER.test(trimmed)) {
      return { name, state: "unresolved_placeholder" as const, value: trimmed };
    }
    return { name, state: "set" as const, value: trimmed };
  });
}

/** The subset of `envReport()` that names a problem worth a warning. */
export function unresolvedPlaceholders(): string[] {
  return envReport()
    .filter((e) => e.state === "unresolved_placeholder")
    .map((e) => e.name);
}
