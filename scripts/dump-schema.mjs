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
import { basename, extname, join } from "node:path";

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
      for (const c of cols) {
        w(`      ${String(c.name).padEnd(24)} ${String(c.type || "").padEnd(12)}${c.pk ? " PK" : ""}${c.notnull ? " NOT NULL" : ""}`);
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
for (const d of BOOK_DIRS) {
  const full = d === "." ? ROOT : join(ROOT, ...d.split("/"));
  if (existsSync(full)) walk(full, 0);
  if (found.length >= SAMPLE) break;
}

w(`═══ book databases (${found.length} sampled) ═══`);
w("");
for (const f of found) describe(f, `book: ${basename(f)}`);
if (found.length === 0) w("ERROR: no book .db files found under " + BOOK_DIRS.join(", "));

const text = lines.join("\n");
if (OUT) {
  writeFileSync(OUT, text, "utf8");
  process.stdout.write(`schema written to ${OUT}\n`);
} else {
  process.stdout.write(text + "\n");
}
