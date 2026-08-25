#!/usr/bin/env node
/**
 * Builds a synthetic corpus in the TRUE Shamela 4 shape, for tests and benchmarks.
 *
 * This shape matters more than it looks. An earlier version of this generator
 * gave book databases a `nass` text column, which no Shamela 4 install has —
 * and because every test ran against those fixtures, a suite of 174 passing
 * tests never noticed that six of the nine tools could not read a real library
 * at all. Fixtures that encode the wrong assumption validate the wrong product.
 *
 * So: `page(id, part, page, number, services)` with no text column,
 * `title(id, page, parent)` with no heading text, files sharded by
 * `book_id % 1000`, and the text itself written to a real Lucene index under
 * `database/store/page` keyed "<book_id>-<page_id>" — exactly as Shamela does.
 *
 * Why synthetic: this repository must never contain Shamela's book texts or
 * databases. These fixtures imitate the *shape* of a Shamela 4 installation —
 * the table and column names, the HTML in page bodies, the separate per-book
 * databases, the catalogue rows for books that were never downloaded — using
 * generated Arabic prose that carries no scholarly content.
 *
 * Everything is deterministic (seeded PRNG) and the ground truth is written to
 * fixture-manifest.json, so tests assert against what this script actually
 * planted rather than against anyone's recollection of what a book says.
 */
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeArabic, stripHtml, tokenize } from "./lib/normalize-mirror.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const OUT = positional[0] ?? join(ROOT, "tests", "fixtures", "generated");

/**
 * Page-count multiplier. The default corpus is small so tests stay fast; the
 * benchmark uses a large scale to show that memory during paging and export
 * really is flat rather than merely small.
 */
const scaleIdx = args.indexOf("--scale");
const SCALE = scaleIdx >= 0 ? Math.max(1, Number(args[scaleIdx + 1]) || 1) : 1;

// ── deterministic PRNG ──────────────────────────────────────────────────────
function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260824);
const pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length];

// Neutral vocabulary: ordinary Arabic words, assembled into filler prose.
const SUBJECTS = ["الباب", "الفصل", "المسألة", "الفرع", "القول", "الوجه", "الشرط", "الركن"];
const VERBS = ["يُذكر", "يُبيَّن", "يُشترط", "يُعتبر", "يُنقل", "يُقيَّد", "يُطلق", "يُفصَّل"];
const OBJECTS = ["في هذا الموضع", "عند التحقيق", "على التفصيل", "في المشهور", "عند الجمهور", "في الرواية"];
const TAILS = ["والله أعلم", "وهذا ظاهر", "وفيه نظر", "وقد تقدم بيانه", "وسيأتي تفصيله"];

function sentence() {
  return `${pick(SUBJECTS)} ${pick(VERBS)} ${pick(OBJECTS)}، ${pick(TAILS)}.`;
}

/** Body text with the same shape Shamela stores: light HTML, diacritics, tatweel. */
function pageBody(planted) {
  const parts = [];
  parts.push(`<p>${sentence()} ${sentence()}</p>`);
  if (planted) parts.push(`<p>${planted}</p>`);
  parts.push(`<p>${sentence()}</p>`);
  if (rand() < 0.3) parts.push(`<span class="hamesh">${sentence()}</span>`);
  if (rand() < 0.2) parts.push(`<p>كتــاب مُشَكَّـلٌ بالحركات: ${sentence()}</p>`);
  return parts.join("<br/>\n");
}

// ── planted phrases ─────────────────────────────────────────────────────────
// Distinctive, invented strings. Tests search for these, so results are
// verifiable against this file rather than against any real fiqh position.
const PLANTED = {
  alpha: "مسألة الزاوية الأولى في الترتيب المعياري",
  beta: "قاعدة الميزان الثاني عند التقدير",
  gamma: "ضابط النسبة الثالثة في التقسيم",
  diacritics: "مَسْأَلَةُ الزَّاوِيَةِ الأُولَى فِي التَّرْتِيبِ المِعْيَارِيِّ",
};

const BOOKS = [
  // category name → madhhab is resolved by the classifier's map, not hardcoded here.
  { id: "1001", title: "الجامع في الترتيب", author: "أبو الفضل الأول", cat: 1, pages: 120, plant: ["alpha", "beta"] },
  { id: "1002", title: "المبسوط في الأصول التنظيمية", author: "أبو الفضل الأول", cat: 1, pages: 200, plant: ["alpha"] },
  { id: "1003", title: "مختصر القواعد", author: "ابن السديد", cat: 1, pages: 80, plant: ["gamma"] },

  { id: "2001", title: "التمهيد للمقادير", author: "أبو زيد الثاني", cat: 2, pages: 150, plant: ["alpha", "gamma"] },
  { id: "2002", title: "الرسالة في الضوابط", author: "أبو زيد الثاني", cat: 2, pages: 90, plant: ["beta"] },
  { id: "2003", title: "شرح المقدمات", author: "القاضي الثاني", cat: 2, pages: 110, plant: ["alpha"] },

  { id: "3001", title: "الأم في التقسيم", author: "أبو الحسن الثالث", cat: 3, pages: 180, plant: ["alpha", "beta", "gamma"] },
  { id: "3002", title: "المهذب في الترتيب", author: "الشيرازي الثالث", cat: 3, pages: 130, plant: ["beta"] },
  { id: "3003", title: "روضة الضوابط", author: "أبو الحسن الثالث", cat: 3, pages: 100, plant: ["alpha"] },

  { id: "4001", title: "المغني في المعايير", author: "ابن قدامة الرابع", cat: 4, pages: 210, plant: ["alpha", "gamma"] },
  { id: "4002", title: "الكافي في التقدير", author: "ابن قدامة الرابع", cat: 4, pages: 95, plant: ["beta"] },
  { id: "4003", title: "زاد المستقنع في الترتيب", author: "الحجاوي الرابع", cat: 4, pages: 70, plant: ["alpha"] },

  { id: "5001", title: "بداية المقارنة", author: "ابن رشد المقارن", cat: 5, pages: 160, plant: ["alpha", "beta", "gamma"] },

  // Categories the seed map does not cover → unclassified.
  { id: "6001", title: "غريب الألفاظ", author: "أبو منصور اللغوي", cat: 6, pages: 60, plant: ["gamma"] },
  { id: "6002", title: "طبقات المصنفين", author: "أبو منصور اللغوي", cat: 6, pages: 55, plant: [] },

  // Title hints one school while its category says another → must be flagged,
  // never silently reclassified.
  { id: "7001", title: "النكت على مذهب الشافعي", author: "أبو الفضل الأول", cat: 1, pages: 65, plant: ["alpha"] },
  // Unmapped category + a title hint → stays unclassified, flagged for review.
  { id: "7002", title: "الفوائد الحنبلية المنتقاة", author: "مجهول", cat: 6, pages: 50, plant: ["beta"] },

  // Catalogued but never downloaded: no file is written for these.
  { id: "8001", title: "كتاب غير منزل أول", author: "أبو الفضل الأول", cat: 1, pages: 0, plant: [], missing: true },
  { id: "8002", title: "كتاب غير منزل ثان", author: "أبو زيد الثاني", cat: 3, pages: 0, plant: [], missing: true },
];

const CATEGORIES = [
  { id: 1, name: "الفقه الحنفي" },
  { id: 2, name: "الفقه المالكي" },
  { id: 3, name: "الفقه الشافعي" },
  { id: 4, name: "الفقه الحنبلي" },
  { id: 5, name: "الفقه المقارن" },
  { id: 6, name: "اللغة والتراجم" },
];

function buildBookDb(path, book, groundTruth, docs) {
  book = { ...book, pages: book.pages * (book.missing ? 1 : SCALE) };
  const db = new DatabaseSync(path);
  // The real Shamela 4 shape: pagination only. No page text, no heading text —
  // both live in Lucene.
  db.exec(`
    CREATE TABLE page  (id INTEGER PRIMARY KEY, part TEXT, page INTEGER, number INTEGER, services TEXT);
    CREATE TABLE title (id INTEGER PRIMARY KEY, page INTEGER, parent INTEGER);
  `);
  const insPage = db.prepare("INSERT INTO page(id, part, page, number, services) VALUES (?, ?, ?, NULL, NULL)");
  const insTitle = db.prepare("INSERT INTO title(id, page, parent) VALUES (?, ?, ?)");

  db.exec("BEGIN");
  const plantPages = {};
  for (const key of book.plant) plantPages[key] = [];

  const pageCount = book.pages;
  let titleSeq = 1;
  for (let i = 1; i <= pageCount; i++) {
    const part = String(Math.floor((i - 1) / 60) + 1);
    // Printed page numbers are deliberately absent for one book, so tests can
    // prove the citation path reports null rather than inventing a number.
    const printed = book.id === "4003" ? null : i;

    let planted = null;
    for (const key of book.plant) {
      // Plant on a deterministic stride so counts are exactly predictable.
      if (i % 17 === (key === "alpha" ? 3 : key === "beta" ? 7 : 11)) {
        planted = key === "alpha" && i % 34 === 3 ? PLANTED.diacritics : PLANTED[key];
        plantPages[key].push(i);
        break;
      }
    }
    insPage.run(i, part, printed);
    // The text goes to the Lucene index, keyed the way Shamela keys it.
    docs.push({ id: `${book.id}-${i}`, body: pageBody(planted), foot: null });

    if (i % 25 === 1) {
      insTitle.run(titleSeq, i, 0);
      docs.push({ id: `${book.id}-${titleSeq}`, body: `${pick(SUBJECTS)} رقم ${Math.ceil(i / 25)}`, title: true });
      titleSeq++;
    }
  }
  db.exec("COMMIT");
  db.close();

  groundTruth[book.id] = plantPages;
}

/**
 * Write a Lucene index with the same field names and key format Shamela uses.
 *
 * Bodies are folded here, in Node, with the same rules the extension applies to
 * queries — mirroring how Shamela's analyzer folded its own index. Folding on
 * both sides with one implementation is what keeps a query able to match.
 */
function writeLuceneIndex(indexDir, entries) {
  const classes = join(ROOT, "java", "test-classes");
  const jarDir = join(ROOT, ".lucene-build");
  if (!existsSync(classes)) {
    throw new Error(`fixture indexer not built. Run: npm run build:java  (looked in ${classes})`);
  }
  const sep = process.platform === "win32" ? ";" : ":";
  const classpath = [join(jarDir, "*"), classes].join(sep);

  const jsonl = entries
    .map((e) =>
      JSON.stringify({
        id: e.id,
        // Stored verbatim so tests can prove quotations keep their diacritics.
        body: e.body,
        // Indexed: folded exactly as the extension folds a query.
        tokens: tokenize(normalizeArabic(stripHtml(e.body))).join(" "),
        foot: e.foot ?? null,
      }),
    )
    .join("\n");

  execFileSync(
    "java",
    ["-cp", classpath, "dev.shamela.fiqh4.testing.FixtureIndexer", indexDir],
    { input: jsonl, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] },
  );
}

/**
 * Make the fixture a faithful miniature install.
 *
 * A real Shamela ships its own Lucene jars under app/lucene/2 and its own JRE
 * under app/<os>/<arch>/jre/2/bin. Reproducing both means tests exercise the
 * same resolution path a user's machine takes, instead of a special case that
 * only exists in the suite — which is exactly how the previous fixtures let a
 * wrong architecture pass 174 tests.
 */
function populateAppDir(appDir) {
  const jarDir = join(ROOT, ".lucene-build");
  const target = join(appDir, "lucene", "2");
  if (existsSync(jarDir)) {
    for (const name of readdirSync(jarDir)) {
      if (name.endsWith(".jar")) copyFileSync(join(jarDir, name), join(target, name));
    }
  }

  // Point the bundled-JRE path at whatever java this machine has.
  const platformDir =
    process.platform === "win32"
      ? join(appDir, "win", "64", "jre", "2", "bin")
      : process.platform === "darwin"
        ? join(appDir, "mac", "64", "jre", "2", "bin")
        : join(appDir, "linux", "64", "jre", "2", "bin");
  mkdirSync(platformDir, { recursive: true });

  const exe = process.platform === "win32" ? "java.exe" : "java";
  let systemJava = null;
  try {
    systemJava = execFileSync(process.platform === "win32" ? "where" : "which", [exe], {
      encoding: "utf8",
    })
      .split("\n")[0]
      .trim();
  } catch {
    systemJava = null;
  }
  if (!systemJava || !existsSync(systemJava)) return;

  const link = join(platformDir, exe);
  try {
    if (!existsSync(link)) symlinkSync(systemJava, link);
  } catch {
    try {
      copyFileSync(systemJava, link);
    } catch {
      // Without it, tests fall back to FIQH4_JAVA_PATH.
    }
  }
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  // A real install is identified by `database` + `app` together, so the
  // fixture must have both or discovery will reject it.
  const dbDir = join(OUT, "database");
  const booksDir = join(dbDir, "book");
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(booksDir, { recursive: true });
  mkdirSync(join(OUT, "app", "lucene", "2"), { recursive: true });
  populateAppDir(join(OUT, "app"));

  // ── master.db ─────────────────────────────────────────────────────────────
  // Column names as a real Shamela 4 master.db uses them.
  const master = new DatabaseSync(join(dbDir, "master.db"));
  master.exec(`
    CREATE TABLE book (
      book_id INTEGER PRIMARY KEY, book_name TEXT, book_category INTEGER,
      main_author INTEGER, major_ondisk INTEGER, minor_ondisk INTEGER, hidden INTEGER
    );
    CREATE TABLE category (category_id INTEGER PRIMARY KEY, category_name TEXT, category_order INTEGER);
    CREATE TABLE author (author_id INTEGER PRIMARY KEY, author_name TEXT, death_number INTEGER);
  `);

  const authors = [...new Set(BOOKS.map((b) => b.author))];
  const authorId = new Map(authors.map((a, i) => [a, i + 1]));
  const insAuth = master.prepare("INSERT INTO author(author_id, author_name, death_number) VALUES (?, ?, NULL)");
  for (const [name, id] of authorId) insAuth.run(id, name);

  const insCat = master.prepare(
    "INSERT INTO category(category_id, category_name, category_order) VALUES (?, ?, ?)",
  );
  for (const [i, c] of CATEGORIES.entries()) insCat.run(c.id, c.name, i);

  const insBook = master.prepare(
    `INSERT INTO book(book_id, book_name, book_category, main_author, major_ondisk, minor_ondisk, hidden)
     VALUES (?, ?, ?, ?, ?, 0, 0)`,
  );
  for (const b of BOOKS) {
    // major_ondisk = 0 marks a book whose content was never downloaded: the
    // file may exist as a skeleton, but there is no text to search.
    insBook.run(Number(b.id), b.title, b.cat, authorId.get(b.author), b.missing ? 0 : 1);
  }
  master.close();

  // ── per-book databases ────────────────────────────────────────────────────
  const groundTruth = {};
  const docs = [];
  const scaled = BOOKS.map((b) => ({ ...b, pages: b.missing ? b.pages : b.pages * SCALE }));
  for (const b of BOOKS) {
    if (b.missing) continue;
    // Sharded by book_id % 1000, exactly as Shamela lays them out.
    const shard = String(Number(b.id) % 1000).padStart(3, "0");
    mkdirSync(join(booksDir, shard), { recursive: true });
    buildBookDb(join(booksDir, shard, `${b.id}.db`), b, groundTruth, docs);
  }

  // A file on disk with no catalogue row.
  mkdirSync(join(booksDir, "999"), { recursive: true });
  buildBookDb(
    join(booksDir, "999", "9999.db"),
    { id: "9999", title: "يتيم", pages: 20, plant: [] },
    groundTruth,
    docs,
  );

  // ── the Lucene index, where Shamela really keeps the text ─────────────────
  const storeDir = join(dbDir, "store");
  const pageIndex = join(storeDir, "page");
  const titleIndex = join(storeDir, "title");
  writeLuceneIndex(pageIndex, docs.filter((d) => !d.title));
  writeLuceneIndex(titleIndex, docs.filter((d) => d.title));

  const manifest = {
    generated_at: new Date().toISOString(),
    note_en:
      "Synthetic Shamela-shaped fixtures. Contains no real book text. Ground truth below is what " +
      "make-fixtures.mjs actually planted; tests assert against it, never against remembered fiqh.",
    root: OUT,
    master_db: join(dbDir, "master.db"),
    books_dir: booksDir,
    store_dir: storeDir,
    page_docs: docs.filter((d) => !d.title).length,
    title_docs: docs.filter((d) => d.title).length,
    categories: CATEGORIES,
    planted_phrases: PLANTED,
    scale: SCALE,
    books: scaled.map((b) => ({
      book_id: b.id,
      title: b.title,
      author: b.author,
      category_id: b.cat,
      category: CATEGORIES.find((c) => c.id === b.cat)?.name ?? null,
      pages: b.pages,
      downloaded: !b.missing,
      planted: b.plant,
      planted_pages: groundTruth[b.id] ?? {},
      has_printed_pages: b.id !== "4003",
    })),
    orphan_files: ["9999"],
  };
  writeFileSync(join(OUT, "fixture-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const downloaded = BOOKS.filter((b) => !b.missing).length;
  process.stdout.write(
    `  lucene index:      ${docs.filter((d) => !d.title).length} pages, ${docs.filter((d) => d.title).length} titles\n`,
  );
  process.stdout.write(
    `fixtures written to ${OUT}\n` +
      `  scale factor:      ${SCALE}\n` +
      `  catalogue entries: ${BOOKS.length}\n` +
      `  book databases:    ${downloaded} (+1 orphan)\n` +
      `  not downloaded:    ${BOOKS.length - downloaded}\n` +
      `  total pages:       ${scaled.reduce((n, b) => n + b.pages, 0)}\n`,
  );
}

main();
