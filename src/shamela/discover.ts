import { existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { Fiqh4Error } from "../util/errors.js";
import { cleaned, javaPath as configuredJavaPath, shamelaDir } from "../config.js";
import { isDirectory, isFile } from "../util/paths.js";
import { log } from "../util/log.js";

/**
 * Locating the Shamela installation, and the Java runtime and Lucene jars it
 * ships with.
 *
 * The decisive test is that a folder contains **both** `database` and `app` —
 * never the folder's name. Installs get renamed, and scanning for a folder
 * literally called "shamela4" misses perfectly good libraries: the one this was
 * developed against lives at `D:\shamela`.
 *
 * Shamela bundles its own Lucene jars and its own JRE. Using them is what lets
 * this extension ship neither: no jar, no runtime, and nothing for the user to
 * build. See docs/ARCHITECTURE.md.
 */

/** Folder names seen in the wild, including the Arabic ones. */
const FOLDER_NAMES = [
  "shamela",
  "shamela4",
  "Shamela",
  "Shamela4",
  "Shamela 4",
  "المكتبة الشاملة",
  "المكتبة الشاملة 4",
];

export interface LibraryLocation {
  /** Install root: the folder holding `database` and `app`. */
  root: string;
  databaseDir: string;
  appDir: string;
  masterDbPath: string;
  /** `database/store` — the Lucene indexes holding all book text. */
  storeDir: string;
  source: "argument" | "env" | "search";
}

/** True when the folder holds both `database` and `app`. */
export function isLibraryRoot(dir: string): boolean {
  if (!dir) return false;
  try {
    return (
      statSync(join(dir, "database")).isDirectory() && statSync(join(dir, "app")).isDirectory()
    );
  } catch {
    return false;
  }
}

/** Every place worth looking, in priority order, without duplicates. */
function searchCandidates(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string | undefined): void => {
    if (!p || seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };

  const home = homedir();
  if (platform() === "win32") {
    for (const drive of ["D:", "C:", "E:", "F:"]) {
      for (const name of FOLDER_NAMES) add(join(`${drive}\\`, name));
    }
    for (const name of FOLDER_NAMES) {
      add(join(home, name));
      add(join(home, "Documents", name));
      add(join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", name));
    }
  } else {
    for (const name of FOLDER_NAMES) {
      add(join(home, name));
      add(join(home, "Documents", name));
      add(join("/opt", name));
      add(join("/srv", name));
    }
  }
  return out;
}

/** Resolve the Shamela root, or fail with everything that was tried. */
export function locateLibrary(explicitRoot?: string): LibraryLocation {
  const fromEnv = shamelaDir();
  const source: LibraryLocation["source"] = explicitRoot
    ? "argument"
    : fromEnv
      ? "env"
      : "search";

  const roots = explicitRoot ? [explicitRoot] : fromEnv ? [fromEnv] : searchCandidates();
  const tried: string[] = [];

  for (const root of roots) {
    tried.push(root);
    if (!isLibraryRoot(root)) continue;
    const databaseDir = join(root, "database");
    // Case matters on Linux and macOS; Windows resolves either spelling.
    const masterDbPath = [
      join(databaseDir, "master.db"),
      join(root, "Database", "master.db"),
    ].find(isFile);
    if (!masterDbPath) continue;
    return {
      root,
      databaseDir,
      appDir: join(root, "app"),
      masterDbPath,
      storeDir: join(databaseDir, "store"),
      source,
    };
  }

  throw new Fiqh4Error(
    "SHAMELA_DIR_MISSING",
    `تعذر العثور على تثبيت المكتبة الشاملة. المجلد الصحيح هو الذي يحوي «database» و«app» معًا ` +
      `(مثال: D:\\shamela). اضبط FIQH4_SHAMELA_DIR عليه. المسارات التي جُرّبت: ${tried.join(" | ")}`,
    `No Shamela installation found (needs both database/ and app/). Tried: ${tried.join(", ")}`,
    { tried },
  );
}

/**
 * The book's own SQLite file, holding pagination and the heading tree.
 *
 * Shamela shards these into 1000 folders by `book_id % 1000`, zero-padded to
 * three digits: 333 → 333/333.db, 9944 → 944/9944.db, 13000 → 000/13000.db.
 * Deriving the path beats walking a thousand directories.
 */
export function bookFilePath(loc: LibraryLocation, bookId: string | number): string | null {
  const id = Number(bookId);
  if (!Number.isFinite(id)) return null;
  const shard = String(id % 1000).padStart(3, "0");
  const candidates = [
    join(loc.databaseDir, "book", shard, `${id}.db`),
    join(loc.root, "Database", "book", shard, `${id}.db`),
  ];
  return candidates.find(isFile) ?? null;
}

/**
 * Shamela's own Java runtime.
 *
 * Preferred over any system Java: it is the exact runtime its Lucene jars were
 * shipped against, and using it means the user needs no Java of their own. Note
 * it is a trimmed JRE — eleven modules, with no `jdk.compiler` and no
 * `java.sql` — so the helper is compiled at build time and never touches JDBC.
 */
export type JavaSource = "configured" | "bundled" | "not_found";

export interface JavaResolution {
  /** The runtime to launch, or `null` when none was found. */
  path: string | null;
  source: JavaSource;
  /**
   * An explicit path that was asked for but does not exist on disk.
   *
   * Kept rather than discarded so `fiqh4_health` can say "your java_path
   * setting was ignored" instead of leaving the user to guess why a runtime
   * they configured is not the one in use.
   */
  ignoredConfigured: string | null;
  /** Every bundled location checked, in order — the useful half of a failure. */
  tried: string[];
}

/**
 * Resolve which Java to run, and say where the answer came from.
 *
 * An explicit path takes precedence, but **a bad explicit path is not fatal**.
 * Returning `null` for a configured path that does not exist meant one unusable
 * string could disable Shamela's own bundled runtime — and MCPB hands us
 * exactly such a string whenever a `user_config` field carries no `default`
 * (see src/config.ts). `cleaned()` already drops the placeholder shape; this
 * function covers the rest: a real typo, or a Java that has since been
 * uninstalled. In both cases the bundled runtime is the right answer, and the
 * ignored setting is reported rather than silently obeyed.
 */
export function resolveJava(appDir: string, configured?: string): JavaResolution {
  const explicit = cleaned(configured) ?? configuredJavaPath();
  let ignoredConfigured: string | null = null;

  if (explicit) {
    if (existsSync(explicit)) {
      return { path: explicit, source: "configured", ignoredConfigured: null, tried: [explicit] };
    }
    ignoredConfigured = explicit;
    log.warn(
      "المسار المضبوط في FIQH4_JAVA_PATH لا يشير إلى ملف موجود؛ سيُستعمل Java التي تشحنها الشاملة",
      { configured: explicit },
    );
  }

  const exe = platform() === "win32" ? "java.exe" : "java";
  const bundled = [
    join(appDir, "win", "64", "jre", "2", "bin", exe),
    join(appDir, "win", "32", "jre", "2", "bin", exe),
    join(appDir, "mac", "64", "jre", "2", "bin", exe),
    join(appDir, "mac", "jre", "2", "bin", exe),
    join(appDir, "linux", "64", "jre", "2", "bin", exe),
  ];
  const found = bundled.find(existsSync);
  const tried = ignoredConfigured ? [ignoredConfigured, ...bundled] : bundled;
  return found
    ? { path: found, source: "bundled", ignoredConfigured, tried }
    : { path: null, source: "not_found", ignoredConfigured, tried };
}

/** The path alone, for callers that do not report on how it was chosen. */
export function findJava(appDir: string, configured?: string): string | null {
  return resolveJava(appDir, configured).path;
}

/** The Lucene jars Shamela ships, which the helper puts on its classpath. */
export function luceneDir(appDir: string): string | null {
  const dir = join(appDir, "lucene", "2");
  return isDirectory(dir) ? dir : null;
}

/** A Lucene index directory under `database/store`. */
export function storeIndexPath(loc: LibraryLocation, name: "page" | "title" | "aya"): string {
  return join(loc.storeDir, name);
}

export function hasStoreIndex(loc: LibraryLocation, name: "page" | "title" | "aya"): boolean {
  return isDirectory(storeIndexPath(loc, name));
}
