#!/usr/bin/env node
/**
 * Builds a synthetic, Shamela-shaped corpus for tests and benchmarks.
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
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

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

function buildBookDb(path, book, groundTruth) {
  book = { ...book, pages: book.pages * (book.missing ? 1 : SCALE) };
  const db = new DatabaseSync(path);
  // Shamela 4's column names — the schema probe must recognise these without
  // them being hardcoded anywhere in src/.
  db.exec(`
    CREATE TABLE book (id INTEGER PRIMARY KEY, page INTEGER, part TEXT, nass TEXT);
    CREATE TABLE title (id INTEGER, tit TEXT, lvl INTEGER);
  `);
  const insPage = db.prepare("INSERT INTO book(id, page, part, nass) VALUES (?, ?, ?, ?)");
  const insTitle = db.prepare("INSERT INTO title(id, tit, lvl) VALUES (?, ?, ?)");

  db.exec("BEGIN");
  const plantPages = {};
  for (const key of book.plant) plantPages[key] = [];

  const pageCount = book.pages;
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
    const body = pageBody(planted);
    insPage.run(i, printed, part, body);
    PAGE_DOCS.push({
      book_id: book.id,
      page_id: i,
      body,
    });

    if (i % 25 === 1) {
      const text = `${pick(SUBJECTS)} رقم ${Math.ceil(i / 25)}`;
      insTitle.run(i, text, 1);
      TITLE_DOCS.push({ book_id: book.id, title_id: i, page_id: i, parent_id: null, text });
    }
    if (i % 50 === 1) {
      const text = `القسم رقم ${Math.ceil(i / 50)}`;
      insTitle.run(i, text, 0);
      TITLE_DOCS.push({ book_id: book.id, title_id: i, page_id: i, parent_id: null, text });
    }
  }
  db.exec("COMMIT");
  db.close();

  groundTruth[book.id] = plantPages;
}

const PAGE_DOCS = [];
const TITLE_DOCS = [];

function findLuceneDir() {
  const candidates = [
    process.env.FIQH4_LUCENE_DIR,
    "D:\\shamela\\app\\lucene\\2",
    "C:\\shamela\\app\\lucene\\2",
  ].filter(Boolean);
  return candidates.find((d) => existsSync(d));
}

function findJava() {
  const candidates = [
    process.env.FIQH4_JAVA_PATH,
    "D:\\shamela\\app\\win\\64\\jre\\2\\bin\\java.exe",
    "C:\\Program Files\\Eclipse Adoptium\\jdk-21.0.3.9-hotspot\\bin\\java.exe",
    "java",
  ].filter(Boolean);
  return candidates.find((p) => p === "java" || existsSync(p)) ?? "java";
}

function buildLuceneFixtures(outRoot, pagesPath, titlesPath) {
  const helper = join(ROOT, "helper", "fiqh4-helper.jar");
  if (!existsSync(helper)) {
    const built = spawnSync(process.execPath, [join(ROOT, "scripts", "build-java.mjs")], {
      cwd: ROOT,
      stdio: "inherit",
      shell: false,
    });
    if (built.status !== 0) throw new Error("Could not build helper jar for fixtures");
  }
  const luceneDir = findLuceneDir();
  if (!luceneDir) throw new Error("Could not find Shamela Lucene jars for fixture index");
  const jars = readdirSync(luceneDir).filter((f) => f.endsWith(".jar"));
  if (jars.length === 0) throw new Error(`No Lucene jars under ${luceneDir}`);
  const cp = [join(luceneDir, "*"), helper].join(delimiter);
  const r = spawnSync(
    findJava(),
    ["-cp", cp, "dev.shamela.fiqh4.FixtureIndexer", outRoot, pagesPath, titlesPath],
    { cwd: ROOT, stdio: "inherit", shell: false },
  );
  if (r.status !== 0) throw new Error(`FixtureIndexer failed with exit ${r.status}`);
}

function main() {
  rmSync(OUT, { recursive: true, force: true });
  const dbDir = join(OUT, "database");
  const booksDir = join(OUT, "Books");
  mkdirSync(dbDir, { recursive: true });
  mkdirSync(booksDir, { recursive: true });
  mkdirSync(join(OUT, "app"), { recursive: true });

  // ── master.db ─────────────────────────────────────────────────────────────
  const master = new DatabaseSync(join(dbDir, "master.db"));
  master.exec(`
    CREATE TABLE book (bkid INTEGER PRIMARY KEY, bk TEXT, cat INTEGER, authno INTEGER, betaka TEXT);
    CREATE TABLE cat  (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE auth (authno INTEGER PRIMARY KEY, auth TEXT);
  `);

  const authors = [...new Set(BOOKS.map((b) => b.author))];
  const authorId = new Map(authors.map((a, i) => [a, i + 1]));
  const insAuth = master.prepare("INSERT INTO auth(authno, auth) VALUES (?, ?)");
  for (const [name, id] of authorId) insAuth.run(id, name);

  const insCat = master.prepare("INSERT INTO cat(id, name) VALUES (?, ?)");
  for (const c of CATEGORIES) insCat.run(c.id, c.name);

  const insBook = master.prepare(
    "INSERT INTO book(bkid, bk, cat, authno, betaka) VALUES (?, ?, ?, ?, ?)",
  );
  for (const b of BOOKS) {
    insBook.run(Number(b.id), b.title, b.cat, authorId.get(b.author), `بطاقة ${b.title}`);
  }
  master.close();

  // ── per-book databases ────────────────────────────────────────────────────
  const groundTruth = {};
  const scaled = BOOKS.map((b) => ({ ...b, pages: b.missing ? b.pages : b.pages * SCALE }));
  for (const b of BOOKS) {
    if (b.missing) continue;
    buildBookDb(join(booksDir, `${b.id}.db`), b, groundTruth);
  }

  // A file on disk with no catalogue row — health must notice it.
  buildBookDb(
    join(booksDir, "9999.db"),
    { id: "9999", title: "يتيم", pages: 20, plant: [] },
    groundTruth,
  );

  const pagesJsonl = join(OUT, "fixture-pages.jsonl");
  const titlesJsonl = join(OUT, "fixture-titles.jsonl");
  writeFileSync(pagesJsonl, PAGE_DOCS.map((d) => JSON.stringify(d)).join("\n") + "\n", "utf8");
  writeFileSync(titlesJsonl, TITLE_DOCS.map((d) => JSON.stringify(d)).join("\n") + "\n", "utf8");
  buildLuceneFixtures(OUT, pagesJsonl, titlesJsonl);

  const manifest = {
    generated_at: new Date().toISOString(),
    note_en:
      "Synthetic Shamela-shaped fixtures. Contains no real book text. Ground truth below is what " +
      "make-fixtures.mjs actually planted; tests assert against it, never against remembered fiqh.",
    root: OUT,
    master_db: join(dbDir, "master.db"),
    books_dir: booksDir,
    page_index: join(OUT, "database", "store", "page"),
    title_index: join(OUT, "database", "store", "title"),
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
    `fixtures written to ${OUT}\n` +
      `  scale factor:      ${SCALE}\n` +
      `  catalogue entries: ${BOOKS.length}\n` +
      `  book databases:    ${downloaded} (+1 orphan)\n` +
      `  not downloaded:    ${BOOKS.length - downloaded}\n` +
      `  total pages:       ${scaled.reduce((n, b) => n + b.pages, 0)}\n`,
  );
}

main();
