import { readdirSync, type Dirent } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, extname, join } from "node:path";
import { Fiqh4Error } from "../util/errors.js";
import { isDirectory, isFile } from "../util/paths.js";
import { log } from "../util/log.js";

/**
 * Locating the library. Layouts differ between Shamela builds and repacked
 * copies, so rather than hardcoding one path we search a short list of likely
 * spots for `master.db`, then index the book files by scanning for `<id>.db`.
 * Everything here is read-only directory traversal.
 */

const MASTER_CANDIDATES = [
  "Database/master.db",
  "database/master.db",
  "master.db",
  "Data/master.db",
  "data/master.db",
  "Database/Master.db",
];

const BOOK_DIR_CANDIDATES = [
  "Books",
  "books",
  "Data/Books",
  "data/books",
  "Database/Books",
  "database/Books",
  "database/books",
  ".",
];

function hasAppAndDatabase(root: string): boolean {
  return (
    (isDirectory(join(root, "database")) || isDirectory(join(root, "Database"))) &&
    isDirectory(join(root, "app"))
  );
}

/** Platform default install locations, tried when FIQH4_SHAMELA_DIR is unset. */
function defaultShamelaRoots(): string[] {
  const home = homedir();
  if (platform() === "win32") {
    return [
      "D:\\shamela",
      "C:\\shamela",
      "D:\\Shamela4",
      "C:\\Shamela4",
      join(home, "Documents", "Shamela4"),
      join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Shamela4"),
    ];
  }
  return [join(home, "shamela"), join(home, "Shamela4"), "/opt/shamela", "/srv/shamela"];
}

export interface LibraryLocation {
  root: string;
  masterDbPath: string;
  bookDirs: string[];
  source: "env" | "argument" | "default_scan";
}

/** Resolve the Shamela root and its master database, or fail with guidance. */
export function locateLibrary(explicitRoot?: string): LibraryLocation {
  const fromEnv = process.env.FIQH4_SHAMELA_DIR?.trim();
  const source: LibraryLocation["source"] = explicitRoot
    ? "argument"
    : fromEnv
      ? "env"
      : "default_scan";

  const roots = explicitRoot ? [explicitRoot] : fromEnv ? [fromEnv] : defaultShamelaRoots();

  for (const root of roots) {
    if (!isDirectory(root)) continue;
    if (!hasAppAndDatabase(root)) continue;
    const master = MASTER_CANDIDATES.map((rel) => join(root, ...rel.split("/"))).find(isFile);
    if (!master) continue;
    const bookDirs = BOOK_DIR_CANDIDATES.map((rel) =>
      rel === "." ? root : join(root, ...rel.split("/")),
    ).filter(isDirectory);
    return { root, masterDbPath: master, bookDirs, source };
  }

  const tried = roots.join(" | ");
  throw new Fiqh4Error(
    "SHAMELA_DIR_MISSING",
    `تعذر العثور على تثبيت المكتبة الشاملة. جرّب ضبط FIQH4_SHAMELA_DIR على مجلد الشاملة (مثال: D:\\shamela). المسارات التي جُرّبت: ${tried}`,
    `Could not locate a Shamela installation containing master.db. Set FIQH4_SHAMELA_DIR. Tried: ${tried}`,
    { tried: roots, master_candidates: MASTER_CANDIDATES },
  );
}

/**
 * Map book id → file path by scanning the book directories for `<id>.db`.
 *
 * Bounded to `maxDepth` so a mis-set root cannot walk the whole filesystem, and
 * the result is cached per location: a large library has thousands of files and
 * the scan should happen once per process.
 */
const bookIndexCache = new Map<string, Map<string, string>>();

export function indexBookFiles(loc: LibraryLocation, maxDepth = 3): Map<string, string> {
  const key = loc.bookDirs.join("|");
  const cached = bookIndexCache.get(key);
  if (cached) return cached;

  const found = new Map<string, string>();
  let scanned = 0;

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" }) as Dirent[];
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).toLowerCase();
      if (ext !== ".db" && ext !== ".sqlite") continue;
      const stem = basename(entry.name, extname(entry.name));
      if (stem.toLowerCase() === "master") continue;
      scanned++;
      // First match wins so a duplicate in a deeper folder cannot shadow the
      // canonical file.
      if (!found.has(stem)) found.set(stem, full);
    }
  };

  for (const dir of loc.bookDirs) walk(dir, 0);
  log.info("indexed book files", { count: found.size, scanned });
  bookIndexCache.set(key, found);
  return found;
}

/** Test seam — the scan result is cached for the process lifetime. */
export function clearBookIndexCache(): void {
  bookIndexCache.clear();
}
