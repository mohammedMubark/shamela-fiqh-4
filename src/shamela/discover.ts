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

/**
 * Everything checked about one candidate root, and the first thing wrong with it.
 *
 * "Could not find the library" is the least useful failure this extension can
 * produce: the user who typed `D:\shamela\database` instead of `D:\shamela`,
 * the one whose drive letter changed, and the one who pointed at an empty
 * folder all got the same sentence. Recording *which* test failed per path is
 * what lets `fiqh4_health` — and the SHAMELA_DIR_MISSING error itself — say
 * "the path exists but holds no `database` folder" instead.
 */
export interface LibraryPathCheck {
  path: string;
  exists: boolean;
  is_directory: boolean;
  has_database: boolean;
  has_app: boolean;
  has_master_db: boolean;
  /** Resolved master.db when the path is usable, else `null`. */
  master_db_path: string | null;
  /** The first failing test, in Arabic, or `null` when the path is a usable root. */
  problem_ar: string | null;
}

/** Run every test `locateLibrary` applies to a root, without throwing. */
export function checkLibraryPath(root: string): LibraryPathCheck {
  const check: LibraryPathCheck = {
    path: root,
    exists: false,
    is_directory: false,
    has_database: false,
    has_app: false,
    has_master_db: false,
    master_db_path: null,
    problem_ar: null,
  };
  try {
    const st = statSync(root);
    check.exists = true;
    check.is_directory = st.isDirectory();
  } catch {
    // stays not-found
  }
  if (!check.exists) {
    check.problem_ar = "المسار غير موجود على القرص.";
    return check;
  }
  if (!check.is_directory) {
    check.problem_ar = "المسار يشير إلى ملف لا إلى مجلد.";
    return check;
  }

  // Mirror isLibraryRoot exactly: lowercase `database` (Windows resolves either
  // spelling; on Linux/macOS case matters and this is what the resolver tests).
  check.has_database = isDirectory(join(root, "database"));
  check.has_app = isDirectory(join(root, "app"));
  if (!check.has_database && !check.has_app) {
    check.problem_ar =
      "المجلد موجود لكنه لا يحوي «database» ولا «app»، فليس هذا مجلد تثبيت الشاملة. " +
      "المطلوب هو المجلد الجذر (مثل D:\\shamela) لا مجلد فرعي داخله.";
    return check;
  }
  if (!check.has_database) {
    check.problem_ar = "المجلد يحوي «app» لكن ينقصه مجلد «database» الذي فيه الكتب والفهارس.";
    return check;
  }
  if (!check.has_app) {
    check.problem_ar =
      "المجلد يحوي «database» لكن ينقصه مجلد «app» الذي تشحن فيه الشاملة Java وLucene، والبحث يحتاجهما.";
    return check;
  }

  check.master_db_path =
    [join(root, "database", "master.db"), join(root, "Database", "master.db")].find(isFile) ?? null;
  check.has_master_db = check.master_db_path !== null;
  if (!check.has_master_db) {
    check.problem_ar =
      "بنية المجلد صحيحة لكن ملف الفهرس الرئيس database/master.db غير موجود. " +
      "افتح برنامج الشاملة مرة واحدة حتى يكتمل تثبيته.";
    return check;
  }
  return check;
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
  const checks: LibraryPathCheck[] = [];

  for (const root of roots) {
    const check = checkLibraryPath(root);
    checks.push(check);
    if (check.problem_ar || !check.master_db_path) continue;
    const databaseDir = join(root, "database");
    return {
      root,
      databaseDir,
      appDir: join(root, "app"),
      masterDbPath: check.master_db_path,
      storeDir: join(databaseDir, "store"),
      source,
    };
  }

  const tried = checks.map((c) => c.path);

  // A path the user named gets its own diagnosis: with exactly one candidate,
  // "not found anywhere" is false precision — the real answer is what is wrong
  // with *that* path, and the first check holds it.
  if (source !== "search") {
    const c = checks[0]!;
    const settingName = source === "env" ? "FIQH4_SHAMELA_DIR (إعداد «مجلد المكتبة الشاملة»)" : "المسار الممرَّر";
    throw new Fiqh4Error(
      "SHAMELA_DIR_MISSING",
      `المسار المضبوط في ${settingName} هو «${c.path}»، لكنه لا يصلح: ${c.problem_ar ?? "سبب غير معروف."}`,
      `Configured Shamela dir "${c.path}" is unusable: ` +
        (!c.exists
          ? "path does not exist."
          : !c.is_directory
            ? "path is a file, not a directory."
            : !c.has_database || !c.has_app
              ? "folder lacks database/ and/or app/ — not a Shamela install root."
              : "database/master.db is missing."),
      { tried, source, checks },
    );
  }

  throw new Fiqh4Error(
    "SHAMELA_DIR_MISSING",
    `لم يُعثر على تثبيت المكتبة الشاملة في المواضع المعتادة. المجلد الصحيح هو الذي يحوي «database» و«app» معًا ` +
      `(مثال: D:\\shamela). اضبط FIQH4_SHAMELA_DIR عليه. المسارات التي جُرّبت: ${tried.join(" | ")}`,
    `No Shamela installation found (needs both database/ and app/). Tried: ${tried.join(", ")}`,
    { tried, source, checks },
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
