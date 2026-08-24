#!/usr/bin/env node
/**
 * Raw schema dump — makes NO assumptions and uses none of the probe logic.
 *
 * When the runtime probe fails to recognise a library, this is what tells us
 * why: it lists every table and column exactly as they are, in master.db and in
 * a sample of book databases, so the alias lists can be extended against real
 * names instead of guesses.
 *
 * It reads structure only — table and column names, and row counts. It prints
 * no book text. Safe to paste publicly.
 *
 * Usage:
 *   node scripts/dump-schema.mjs                     # uses FIQH4_SHAMELA_DIR
 *   node scripts/dump-schema.mjs D:\shamela          # or an explicit path
 *   node scripts/dump-schema.mjs --books 5 --out schema.txt
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const argv = process.argv.slice(2);

// Options that consume the next argument; everything else is positional.
const VALUED = new Set(["--books", "--out"]);
const opts = new Map();
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (VALUED.has(a)) {
    opts.set(a, argv[++i]);
  } else if (a.startsWith("--")) {
    const eq = a.indexOf("=");
    if (eq > 0) opts.set(a.slice(0, eq), a.slice(eq + 1));
    else opts.set(a, true);
  } else {
    positional.push(a);
  }
}

const SAMPLE = Number(opts.get("--books")) || 3;
const OUT = typeof opts.get("--out") === "string" ? opts.get("--out") : null;

/**
 * Same default locations the extension itself scans.
 *
 * Duplicated here rather than imported on purpose: this script has to work when
 * the library cannot be read at all, which is exactly when importing the built
 * output is least reliable. Keep in sync with src/shamela/discover.ts.
 */
function defaultRoots() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (process.platform === "win32") {
    return [
      "D:\\shamela",
      "C:\\shamela",
      "D:\\Shamela4",
      "C:\\Shamela4",
      home ? join(home, "Documents", "Shamela4") : null,
    ].filter(Boolean);
  }
  return [home ? join(home, "shamela") : null, home ? join(home, "Shamela4") : null, "/opt/shamela"].filter(Boolean);
}

const MASTER_RELATIVE = ["Database/master.db", "database/master.db", "master.db", "Data/master.db"];
const hasMaster = (root) => MASTER_RELATIVE.some((r) => existsSync(join(root, ...r.split("/"))));

const explicit = positional[0] ?? process.env.FIQH4_SHAMELA_DIR;
const tried = [];
let ROOT = null;

if (explicit) {
  tried.push(explicit);
  ROOT = explicit;
} else {
  for (const candidate of defaultRoots()) {
    tried.push(candidate);
    if (hasMaster(candidate)) {
      ROOT = candidate;
      break;
    }
  }
}

if (!ROOT) {
  process.stderr.write(
    "Could not locate a Shamela installation.\n\n" +
      "Pass the folder explicitly:\n" +
      "  npm run fiqh4:schema -- D:\\shamela --books 3 --out schema.txt\n\n" +
      "or set FIQH4_SHAMELA_DIR.\n\n" +
      `Tried: ${tried.join(", ") || "(nothing)"}\n`,
  );
  process.exit(1);
}

const lines = [];
const w = (s = "") => lines.push(s);

function describe(path, label) {
  w(`### ${label}`);
  w(`file: ${path}`);
  try {
    w(`size: ${(statSync(path).size / 1048576).toFixed(1)} MB`);
  } catch { /* ignore */ }

  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (e) {
    w(`ERROR opening: ${e.message}`);
    w("");
    return;
  }

  try {
    const objects = db
      .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all();

    if (objects.length === 0) w("(no tables)");

    for (const o of objects) {
      if (o.type !== "table" && o.type !== "view") {
        w(`  ${o.type}: ${o.name}`);
        continue;
      }
      let cols = [];
      let count = "?";
      try {
        cols = db.prepare(`PRAGMA table_info("${String(o.name).replace(/"/g, '""')}")`).all();
      } catch (e) {
        w(`  ${o.type} ${o.name}: PRAGMA failed — ${e.message}`);
        continue;
      }
      try {
        count = db.prepare(`SELECT COUNT(*) n FROM "${String(o.name).replace(/"/g, '""')}"`).get().n;
      } catch { /* view may not be countable */ }

      w(`  ${o.type} ${o.name}  (${count} rows)`);

      // Total bytes per column. This is what distinguishes a metadata table
      // from one that actually holds book text: a column storing pages runs to
      // hundreds of kilobytes, an id column to a few. No value is ever printed
      // — only how much space the column occupies.
      const sizes = new Map();
      if (typeof count === "number" && count > 0) {
        for (const c of cols) {
          try {
            const q = `SELECT SUM(LENGTH(CAST("${String(c.name).replace(/"/g, '""')}" AS BLOB))) s FROM "${String(o.name).replace(/"/g, '""')}"`;
            sizes.set(c.name, Number(db.prepare(q).get().s ?? 0));
          } catch { /* column type may not be measurable */ }
        }
      }

      for (const c of cols) {
        const bytes = sizes.get(c.name);
        const sizeNote =
          bytes === undefined ? "" : `  ${(bytes / 1024).toFixed(1)} KB total`;
        w(`      ${String(c.name).padEnd(24)} ${String(c.type || "").padEnd(12)}${c.pk ? " PK" : ""}${c.notnull ? " NOT NULL" : ""}${sizeNote}`);
      }

      const biggest = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0];
      if (biggest && biggest[1] > 4096) {
        w(`      → largest column: ${biggest[0]} (${(biggest[1] / 1024).toFixed(1)} KB) — likely where the text lives`);
      } else if (biggest) {
        w(`      → no column holds bulk text in this table (largest: ${biggest[0]}, ${(biggest[1] / 1024).toFixed(1)} KB)`);
      }
    }
  } finally {
    db.close();
  }
  w("");
}

// ── master.db ───────────────────────────────────────────────────────────────
const MASTER_CANDIDATES = ["Database/master.db", "database/master.db", "master.db", "Data/master.db"];
const master = MASTER_CANDIDATES.map((r) => join(ROOT, ...r.split("/"))).find(existsSync);

w("═══ shamela-fiqh-4 raw schema dump ═══");
w(`root: ${ROOT}`);
w(`generated: ${new Date().toISOString()}`);
w("structure only — no book text is printed");
w("");

if (!master) {
  w(`ERROR: no master.db found. Tried: ${MASTER_CANDIDATES.join(", ")}`);
} else {
  describe(master, "master.db");
}

// ── which books does the catalogue say are actually on disk? ────────────────
//
// A book database can exist while its text has never been downloaded. If we
// sample blindly we may look only at skeletons and conclude, wrongly, that the
// library stores no text at all. So: read the catalogue's own on-disk flags,
// report their distribution, and prefer sampling books the catalogue says are
// present — and within the four fiqh sections, since that is the working scope.
let preferredIds = [];
if (master) {
  w("═══ catalogue: which books are on disk ═══");
  try {
    const db = new DatabaseSync(master, { readOnly: true });
    try {
      const cols = db.prepare(`PRAGMA table_info("book")`).all().map((c) => String(c.name));
      const flags = ["major_ondisk", "minor_ondisk", "major_online", "minor_online", "printed", "hidden"].filter(
        (f) => cols.includes(f),
      );
      w(`flag columns present: ${flags.join(", ") || "(none)"}`);
      for (const f of flags) {
        const rows = db
          .prepare(`SELECT "${f}" v, COUNT(*) n FROM book GROUP BY "${f}" ORDER BY n DESC LIMIT 6`)
          .all();
        w(`  ${f.padEnd(14)} ${rows.map((r) => `${r.v}=${r.n}`).join("  ")}`);
      }

      // The four madhhab sections, by the names Shamela itself uses.
      if (cols.includes("book_category")) {
        const FOUR = ["الفقه الحنفي", "الفقه المالكي", "الفقه الشافعي", "الفقه الحنبلي"];
        const cats = db.prepare(`SELECT category_id, category_name FROM category`).all();
        const wanted = cats.filter((c) => FOUR.includes(String(c.category_name).trim()));
        w("");
        w("four madhhab sections:");
        for (const c of wanted) {
          const n = db.prepare(`SELECT COUNT(*) n FROM book WHERE book_category = ?`).get(c.category_id).n;
          w(`  ${String(c.category_name).padEnd(16)} id=${String(c.category_id).padEnd(5)} ${n} books`);
        }
        if (wanted.length === 0) {
          w("  (none matched — category names in this library:)");
          for (const c of cats.slice(0, 45)) w(`    ${c.category_id}: ${c.category_name}`);
        }

        // Prefer the largest on-disk books in those sections: if any book has
        // text, a big one in scope will.
        const ids = wanted.map((c) => c.category_id);
        if (ids.length > 0) {
          const order = flags.includes("major_ondisk") ? "major_ondisk DESC, minor_ondisk DESC," : "";
          const rows = db
            .prepare(
              `SELECT book_id, book_name FROM book
                WHERE book_category IN (${ids.map(() => "?").join(",")})
                ORDER BY ${order} book_id ASC LIMIT 40`,
            )
            .all(...ids);
          preferredIds = rows.map((r) => String(r.book_id));
          w("");
          w(`candidate books in the four sections: ${preferredIds.slice(0, 12).join(", ")}${preferredIds.length > 12 ? " …" : ""}`);
        }
      }
    } finally {
      db.close();
    }
  } catch (e) {
    w(`could not read catalogue flags: ${e.message}`);
  }
  w("");
}

// ── a sample of book databases ──────────────────────────────────────────────
const BOOK_DIRS = ["Books", "books", "Data/Books", "database/books", "."];
const found = [];
const walk = (dir, depth) => {
  if (depth > 3 || found.length >= SAMPLE) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const e of entries) {
    if (found.length >= SAMPLE) return;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, depth + 1);
    else if (/\.(db|sqlite)$/i.test(e.name) && basename(e.name, extname(e.name)).toLowerCase() !== "master") {
      found.push(full);
    }
  }
};
// Shamela shards book files into 1000 folders by the last three digits of the
// book id, so a targeted lookup beats walking the tree.
function locateBook(id) {
  const shard = String(id).padStart(4, "0").slice(-3);
  const candidates = [
    join(ROOT, "database", "book", shard, `${id}.db`),
    join(ROOT, "Database", "book", shard, `${id}.db`),
    join(ROOT, "database", "book", `${id}.db`),
    join(ROOT, "Books", `${id}.db`),
  ];
  return candidates.find(existsSync) ?? null;
}

for (const id of preferredIds) {
  if (found.length >= SAMPLE) break;
  const p = locateBook(id);
  if (p) found.push(p);
}

if (found.length < SAMPLE) {
  for (const d of BOOK_DIRS) {
    const full = d === "." ? ROOT : join(ROOT, ...d.split("/"));
    if (existsSync(full)) walk(full, 0);
    if (found.length >= SAMPLE) break;
  }
}

w(`═══ book databases (${found.length} sampled) ═══`);
w("");
for (const f of found) describe(f, `book: ${basename(f)}`);
if (found.length === 0) w("ERROR: no book .db files found under " + BOOK_DIRS.join(", "));

// If the page table carries no text, the text must live somewhere else. List
// what actually sits in the book folder — every extension, not just .db — so a
// companion file or a different container shows up instead of being guessed at.
if (found.length > 0) {
  const bookDir = dirname(found[0]);
  w("═══ files beside the book databases ═══");
  w(`directory: ${bookDir}`);
  try {
    const entries = readdirSync(bookDir, { withFileTypes: true, encoding: "utf8" });
    const byExt = new Map();
    for (const e of entries) {
      const ext = (extname(e.name) || "(none)").toLowerCase();
      const rec = byExt.get(ext) ?? { count: 0, bytes: 0 };
      rec.count++;
      try {
        rec.bytes += statSync(join(bookDir, e.name)).size;
      } catch { /* ignore */ }
      byExt.set(ext, rec);
    }
    w(`total entries: ${entries.length}`);
    for (const [ext, rec] of [...byExt.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
      w(`  ${ext.padEnd(10)} ${String(rec.count).padStart(6)} files   ${(rec.bytes / 1048576).toFixed(1)} MB`);
    }
    w("");
    w("first 15 entries by name:");
    for (const e of entries.slice(0, 15)) {
      let size = "?";
      try {
        size = `${(statSync(join(bookDir, e.name)).size / 1024).toFixed(1)} KB`;
      } catch { /* ignore */ }
      w(`  ${e.isDirectory() ? "[dir] " : "      "}${e.name.padEnd(28)} ${size}`);
    }
  } catch (e) {
    w(`could not list: ${e.message}`);
  }
  w("");

  // The install root and the database folder: if text lives in a separate
  // store rather than beside the structure files, it shows up here.
  for (const label of ["", "database", "Database"]) {
    const dir = label ? join(ROOT, label) : ROOT;
    if (!existsSync(dir)) continue;
    w(`listing: ${dir}`);
    try {
      const entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
      for (const e of entries.slice(0, 30)) {
        let size = "";
        try {
          const st = statSync(join(dir, e.name));
          size = e.isDirectory() ? "" : ` ${(st.size / 1048576).toFixed(1)} MB`;
        } catch { /* ignore */ }
        w(`  ${e.isDirectory() ? "[dir] " : "      "}${e.name}${size}`);
      }
      if (entries.length > 30) w(`  … and ${entries.length - 30} more`);
    } catch (e) {
      w(`  could not list: ${e.message}`);
    }
    w("");
  }

  // Also look one level up: some layouts keep text in a sibling folder.
  const parent = dirname(bookDir);
  w(`parent directory: ${parent}`);
  try {
    const entries = readdirSync(parent, { withFileTypes: true, encoding: "utf8" });
    w(`entries: ${entries.length}`);
    for (const e of entries.slice(0, 20)) w(`  ${e.isDirectory() ? "[dir] " : "      "}${e.name}`);
  } catch (e) {
    w(`could not list: ${e.message}`);
  }
  w("");
}

const text = lines.join("\n");
if (OUT) {
  writeFileSync(OUT, text, "utf8");
  process.stdout.write(`schema written to ${OUT}\n`);
} else {
  process.stdout.write(text + "\n");
}
