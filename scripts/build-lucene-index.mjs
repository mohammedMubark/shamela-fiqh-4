#!/usr/bin/env node
/**
 * Feeds the Lucene bridge. Only needed if you have opted into the Lucene
 * backend by building the jar and setting FIQH4_LUCENE_JAR.
 *
 * Text is normalised here, in Node, using the same versioned normaliser the
 * default engine uses — the Java side indexes it verbatim. That is what keeps
 * the two backends agreeing on what a query means.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "dist", "index.js"))) {
  process.stderr.write("dist/ not found — run `npm run build` first.\n");
  process.exit(1);
}

const { MasterCatalogue } = await import("../dist/shamela/masterRepo.js");
const { Classifier } = await import("../dist/classify/classifier.js");
const { BookReader } = await import("../dist/shamela/bookRepo.js");
const { LuceneSearchEngine } = await import("../dist/search/luceneEngine.js");
const { normalizeArabic } = await import("../dist/text/normalize.js");

if (!process.env.FIQH4_LUCENE_JAR) {
  process.stderr.write("FIQH4_LUCENE_JAR is not set. Build it with `npm run java:build` first.\n");
  process.exit(1);
}

const catalogue = MasterCatalogue.open();
const books = Classifier.load().classifyAll(catalogue.books()).filter((b) => b.downloaded);
const engine = await LuceneSearchEngine.open();

process.stdout.write(`indexing ${books.length} books into ${engine.indexDir}\n`);
const BATCH = 500;
let total = 0;
let first = true;

for (const book of books) {
  const reader = BookReader.open(book.file_path);
  let batch = [];
  let pages = 0;
  try {
    for (const page of reader.streamPages(BATCH)) {
      const text_search = normalizeArabic(page.text_original);
      if (!text_search) continue;
      batch.push({
        book_id: book.book_id,
        page_id: page.page_id,
        part: page.part,
        printed_page: page.printed_page,
        text_search,
      });
      if (batch.length >= BATCH) {
        // `reset` only on the very first batch: it wipes the index once, then
        // each book's first batch replaces that book's existing documents.
        await engine.indexBatch(batch, { reset: first, commit: false });
        first = false;
        pages += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await engine.indexBatch(batch, { reset: first, commit: true });
      first = false;
      pages += batch.length;
    }
  } finally {
    reader.close();
  }
  total += pages;
  process.stdout.write(`  ${book.book_id} — ${pages} pages\n`);
}

await engine.refreshBooks();
engine.close();
catalogue.close();
process.stdout.write(`\nindexed ${total} pages into the Lucene index\n`);
