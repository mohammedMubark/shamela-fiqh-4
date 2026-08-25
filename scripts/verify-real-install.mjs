#!/usr/bin/env node
/**
 * Read-only audit of a REAL Shamela 4 installation.
 *
 * Run this on the machine that actually has the library:
 *
 *   npm run build
 *   set FIQH4_SHAMELA_DIR=D:\shamela      (Windows)
 *   npm run fiqh4:verify
 *
 * It answers the questions the category map cannot answer on its own: what the
 * schema really looks like, what the categories are actually called, how many
 * books each rule captures, and which books are left ambiguous or unclassified.
 *
 * It opens nothing for writing and changes nothing. Pass --json for a machine
 * readable dump, or --out FILE to save it.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "dist", "index.js"))) {
  process.stderr.write("dist/ not found — run `npm run build` first.\n");
  process.exit(1);
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const outIdx = args.indexOf("--out");
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;

const { MasterCatalogue } = await import("../dist/shamela/masterRepo.js");
const { Classifier } = await import("../dist/classify/classifier.js");
const { BookReader } = await import("../dist/shamela/bookRepo.js");
const { MADHHAB_AR, MADHHAB_VALUES } = await import("../dist/classify/types.js");

let catalogue;
try {
  catalogue = MasterCatalogue.open();
} catch (e) {
  process.stderr.write(`${e.messageAr ?? e.message}\n`);
  process.exit(2);
}

const classifier = Classifier.load();
const books = classifier.classifyAll(catalogue.books());
const categories = catalogue.categories();

// Probe a few real book databases to confirm the per-book schema too.
const sampleProbes = [];
for (const book of books.filter((b) => b.downloaded).slice(0, 5)) {
  try {
    const reader = BookReader.open(book.file_path);
    sampleProbes.push({
      book_id: book.book_id,
      title: book.title,
      pages_table: reader.profile.pagesTable,
      page_id_column: reader.profile.pageId,
      text_column: reader.profile.pageText,
      part_column: reader.profile.pagePart,
      printed_page_column: reader.profile.pagePrinted,
      titles_table: reader.profile.titlesTable,
      page_count: reader.pageCount(),
      notes_ar: reader.profile.notes,
    });
    reader.close();
  } catch (e) {
    // Keep the structured details: on SCHEMA_UNRECOGNISED they carry the table
    // and column names that were actually found, which is the whole point of
    // running this on a library the probe could not read.
    sampleProbes.push({
      book_id: book.book_id,
      title: book.title,
      file_path: book.file_path,
      error: e.messageAr ?? e.message,
      code: e.code ?? null,
      details: e.details ?? null,
    });
  }
}

const perMadhhab = MADHHAB_VALUES.map((m) => {
  const inM = books.filter((b) => b.madhhab === m);
  return {
    madhhab: m,
    madhhab_ar: MADHHAB_AR[m],
    books: inM.length,
    downloaded: inM.filter((b) => b.downloaded).length,
    verified: inM.filter((b) => b.verification_status === "verified").length,
    needs_review: inM.filter((b) => b.verification_status === "needs_review").length,
    unverified: inM.filter((b) => b.verification_status === "unverified").length,
  };
});

// How many books each map rule actually captured — this is what tells you
// whether a rule is pulling its weight or matching nothing at all.
const ruleHits = new Map();
for (const b of books) {
  if (!b.matched_rule) continue;
  ruleHits.set(b.matched_rule, (ruleHits.get(b.matched_rule) ?? 0) + 1);
}

const categoryBreakdown = [...new Map(
  books.map((b) => [b.category ?? "(بلا فئة)", null]),
).keys()].map((name) => {
  const inCat = books.filter((b) => (b.category ?? "(بلا فئة)") === name);
  const madhhabs = [...new Set(inCat.map((b) => b.madhhab))];
  return {
    category: name,
    books: inCat.length,
    resolved_to: madhhabs,
    mapped: madhhabs.some((m) => m !== "unclassified"),
  };
}).sort((a, b) => b.books - a.books);

const ambiguous = books.filter((b) => b.ambiguity_reasons.length > 0);
const reasonCounts = new Map();
for (const b of ambiguous) {
  for (const r of b.ambiguity_reasons) {
    const key = r.split(":")[0];
    reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
  }
}

const report = {
  generated_at: new Date().toISOString(),
  library: {
    root: catalogue.location.root,
    master_db: catalogue.location.masterDbPath,
    book_dirs: catalogue.location.bookDirs,
    resolved_from: catalogue.location.source,
    ...catalogue.counts(),
    orphan_book_files: catalogue.orphanFiles().length,
  },
  master_schema: {
    books_table: catalogue.profile.booksTable,
    book_id_column: catalogue.profile.bookId,
    title_column: catalogue.profile.bookTitle,
    author_name_column: catalogue.profile.bookAuthorName,
    author_id_column: catalogue.profile.bookAuthorId,
    category_column: catalogue.profile.bookCategoryId,
    categories_table: catalogue.profile.categoriesTable,
    category_id_column: catalogue.profile.categoryId,
    category_name_column: catalogue.profile.categoryName,
    authors_table: catalogue.profile.authorsTable,
    all_tables: catalogue.profile.tables.map((t) => ({ name: t.name, columns: t.columns })),
    notes_ar: catalogue.profile.notes,
  },
  book_schema_samples: sampleProbes,
  categories_in_library: categories,
  category_breakdown: categoryBreakdown,
  classification: {
    map_file: classifier.config.mapPath,
    overrides_file: classifier.config.overridesPath,
    rules: classifier.config.rules.map((r) => ({
      id: r.id,
      madhhab: r.madhhab,
      match_type: r.match_type,
      reviewed: r.reviewed,
      books_matched: ruleHits.get(r.id) ?? 0,
    })),
    per_madhhab: perMadhhab,
    unmapped_categories: classifier.unmappedCategories(books),
    ambiguous_books: ambiguous.length,
    ambiguity_reason_counts: [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })),
    sample_ambiguous: ambiguous.slice(0, 40).map((b) => ({
      book_id: b.book_id,
      title: b.title,
      author: b.author,
      category: b.category,
      madhhab: b.madhhab,
      verification_status: b.verification_status,
      ambiguity_reasons: b.ambiguity_reasons,
    })),
  },
};

catalogue.close();

if (outFile) {
  writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`report written to ${outFile}\n`);
}
if (asJson) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(0);
}

// ── human-readable summary ──────────────────────────────────────────────────
const w = (s) => process.stdout.write(s + "\n");
w("");
w("═══ تقرير فحص تثبيت المكتبة الشاملة ═══");
w("");
w(`المجلد           : ${report.library.root}`);
w(`قاعدة الفهرس     : ${report.library.master_db}`);
w(`عدد الكتب        : ${report.library.catalogue} في الفهرس، ${report.library.downloaded} مُنزَّل`);
w(`ملفات على القرص  : ${report.library.files_on_disk} (${report.library.orphan_book_files} بلا سجل في الفهرس)`);
w("");
w("─── بنية master.db المكتشفة ───");
const ms = report.master_schema;
w(`  جدول الكتب     : ${ms.books_table} (معرّف=${ms.book_id_column}، عنوان=${ms.title_column})`);
w(`  المؤلف         : ${ms.author_name_column ?? `عبر ${ms.authors_table}.${ms.author_id_column}`}`);
w(`  الفئة          : ${ms.category_column ?? "(غير موجود)"} → ${ms.categories_table ?? "(بلا جدول فئات)"}`);
for (const n of ms.notes_ar) w(`  ملاحظة        : ${n}`);
w("");
w("─── عينة من بنية كتب ───");
for (const p of report.book_schema_samples) {
  if (p.error) {
    w(`  ${p.book_id}: خطأ — ${p.error}`);
    const tables = p.details?.tables;
    if (Array.isArray(tables)) {
      w(`      الجداول الموجودة فعلًا في هذا الكتاب:`);
      for (const t of tables) w(`        ${t}`);
    }
    continue;
  }
  w(`  ${String(p.book_id).padEnd(8)} ${p.pages_table}(${p.page_id_column}, ${p.text_column}, جزء=${p.part_column ?? "—"}, صفحة=${p.printed_page_column ?? "—"}) ${p.page_count} صفحة`);
}
w("");
w("─── التوزيع حسب المذهب ───");
w("  المذهب          الكتب   منزّل   موثّق  يحتاج مراجعة  غير محقق");
for (const r of report.classification.per_madhhab) {
  w(`  ${r.madhhab_ar.padEnd(14)} ${String(r.books).padStart(5)} ${String(r.downloaded).padStart(7)} ${String(r.verified).padStart(7)} ${String(r.needs_review).padStart(12)} ${String(r.unverified).padStart(10)}`);
}
w("");
w("─── فعالية قواعد الخريطة ───");
for (const r of report.classification.rules) {
  const flag = r.books_matched === 0 ? "  ← لم تطابق شيئًا" : "";
  w(`  ${r.id.padEnd(22)} ${r.madhhab.padEnd(12)} ${r.match_type.padEnd(9)} ${String(r.books_matched).padStart(5)} كتاب${flag}`);
}
w("");
const unmapped = report.classification.unmapped_categories;
w(`─── فئات غير مغطاة بالخريطة (${unmapped.length}) ───`);
for (const c of unmapped.slice(0, 30)) w(`  ${String(c.book_count).padStart(5)} كتاب — ${c.category}`);
if (unmapped.length > 30) w(`  … و${unmapped.length - 30} فئة أخرى`);
w("");
w(`─── كتب ملتبسة (${report.classification.ambiguous_books}) ───`);
for (const r of report.classification.ambiguity_reason_counts) w(`  ${String(r.count).padStart(5)} — ${r.reason}`);
w("");
const totalClassified = report.classification.per_madhhab
  .filter((r) => r.madhhab !== "unclassified")
  .reduce((n, r) => n + r.books, 0);
if (totalClassified === 0) {
  w("⚠  لم يُصنَّف أي كتاب. هذا يعني أن مُرشِّح المخطط لم يتعرف على بنية مكتبتك،");
  w("   لا أن مكتبتك خالية من كتب الفقه. شغّل الأمر التالي وأرسل مخرجاته:");
  w("     npm run fiqh4:schema -- --books 3 --out schema.txt");
  w("   (يطبع أسماء الجداول والأعمدة فقط، بلا أي نص من الكتب)");
  w("");
}
w("الخطوات التالية:");
w("  1. راجع الفئات غير المغطاة أعلاه وأضف قواعد لها في config/madhhab-map.seed.json.");
w("  2. راجع الكتب الملتبسة وثبّت نسبتها في config/madhhab-overrides.json (وهي وحدها تُنتج verification_status = verified).");
w("  3. أعد تشغيل هذا الأمر حتى تصل الفئات غير المغطاة إلى ما ترضاه.");
w("  4. شغّل: npm run fiqh4:bench — لا خطوة فهرسة، الفهرس فهرس الشاملة نفسه");
w("  5. أرسل مخرجات --json لتوثيقها في docs/FEASIBILITY.md وdocs/BENCHMARKS.md.");
w("");
