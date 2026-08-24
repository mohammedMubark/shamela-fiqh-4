import { homedir, platform } from "node:os";
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Fiqh4Error } from "./errors.js";

/**
 * All write targets funnel through here. Two invariants hold no matter what a
 * caller passes:
 *   1. nothing is ever written inside the Shamela installation, and
 *   2. nothing escapes the configured output root via traversal or symlink.
 */

/** Per-OS data directory for derived artefacts (index, exports). */
export function defaultDataDir(): string {
  const home = homedir();
  switch (platform()) {
    case "win32":
      return join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "shamela-fiqh-4");
    case "darwin":
      return join(home, "Library", "Application Support", "shamela-fiqh-4");
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, ".local", "share"), "shamela-fiqh-4");
  }
}

export function defaultIndexDir(): string {
  return process.env.FIQH4_INDEX_DIR?.trim() || join(defaultDataDir(), "index");
}

export function defaultOutputDir(): string {
  return process.env.FIQH4_OUTPUT_DIR?.trim() || join(defaultDataDir(), "exports");
}

/**
 * Resolve a path as far as it exists on disk. A path we are about to *create*
 * has no realpath yet, so we walk up to the nearest existing ancestor and
 * resolve that — which is what defeats symlinked parents.
 */
function realpathOfNearestExisting(p: string): string {
  let current = resolve(p);
  const seen = new Set<string>();
  while (!existsSync(current)) {
    const parent = resolve(current, "..");
    if (parent === current || seen.has(parent)) return current;
    seen.add(parent);
    current = parent;
  }
  try {
    return realpathSync(current);
  } catch {
    return current;
  }
}

/** True when `child` is `parent` itself or lives beneath it. */
export function isInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export interface SafeDirOptions {
  /** Requested directory. Relative paths resolve against `outputRoot`. */
  requested?: string | undefined;
  /** The configured output root; the ceiling for every write. */
  outputRoot: string;
  /** Shamela install root, if known — always forbidden as a write target. */
  shamelaDir?: string | undefined;
  /** Create the directory when it does not exist. */
  create?: boolean;
}

/**
 * Validate and resolve a directory we intend to write into.
 *
 * Rejects: absolute paths outside the output root, traversal out of it, and
 * anything at or under the Shamela installation — checked against realpaths so
 * a symlink cannot smuggle a write back into the library.
 */
export function resolveSafeOutputDir(opts: SafeDirOptions): string {
  const outputRoot = resolve(opts.outputRoot);
  const requested = opts.requested?.trim();

  const candidate = !requested
    ? outputRoot
    : isAbsolute(requested)
      ? resolve(requested)
      : resolve(outputRoot, requested);

  const realCandidate = realpathOfNearestExisting(candidate);
  const realRoot = realpathOfNearestExisting(outputRoot);

  // The library check runs first deliberately. A symlink sitting inside the
  // output root but pointing at the library fails both checks; reporting it as
  // "you tried to write into Shamela" tells the user what actually went wrong,
  // where "outside the output root" would send them looking in the wrong place.
  if (opts.shamelaDir) {
    const realShamela = realpathOfNearestExisting(opts.shamelaDir);
    if (isInside(realShamela, realCandidate)) {
      throw new Fiqh4Error(
        "WRITE_INTO_SHAMELA_DIR",
        "مُنع الكتابة داخل مجلد المكتبة الشاملة. مجلد الشاملة يُفتح للقراءة فقط.",
        "Refusing to write inside the Shamela installation; it is read-only.",
        { requested: realCandidate, shamela_dir: realShamela },
      );
    }
  }

  if (!isInside(realRoot, realCandidate)) {
    throw new Fiqh4Error(
      "UNSAFE_OUTPUT_PATH",
      `مسار التصدير المطلوب يقع خارج مجلد الإخراج المسموح به. المسموح: ${realRoot}`,
      `Requested output path escapes the configured output root (${realRoot}).`,
      { requested: candidate, output_root: realRoot },
    );
  }

  if (opts.create !== false) {
    mkdirSync(candidate, { recursive: true });
  }
  return candidate;
}

/** Reject filename fragments that could traverse or target a device. */
export function assertSafeSegment(name: string, what = "الاسم"): string {
  const bad = /[\\/]|^\.\.?$|^$|[\0<>:"|?*]/.test(name);
  if (bad) {
    throw new Fiqh4Error(
      "UNSAFE_OUTPUT_PATH",
      `${what} غير صالح: يجب ألا يحتوي على فواصل مسار أو محارف محجوزة.`,
      `Unsafe path segment: ${JSON.stringify(name)}`,
      { segment: name },
    );
  }
  return name;
}

export function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
