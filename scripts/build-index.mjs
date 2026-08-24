#!/usr/bin/env node
/**
 * Builds (or refreshes) the derived search index.
 *
 * Run this after installing the extension, and again whenever books are added
 * to the library. Only downloaded books are indexed; the run is incremental, so
 * a rebuild after adding one book re-reads only that book.
 *
 * Usage:
 *   node scripts/build-index.mjs [--force] [--madhhab hanafi,shafii] [--index-dir DIR]
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

if (!existsSync(join(ROOT, "dist", "index.js"))) {
  process.stderr.write("dist/ not found — run `npm run build` first.\n");
  process.exit(1);
}

const { MasterCatalogue } = await import("../dist/shamela/masterRepo.js");
const { Classifier } = await import("../dist/classify/classifier.js");
const { buildIndex } = await import("../dist/search/indexer.js");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const indexDir = value("--index-dir");
const madhhabFilter = value("--madhhab")?.split(",").map((s) => s.trim()).filter(Boolean);

const catalogue = MasterCatalogue.open(value("--shamela-dir"));
const classifier = Classifier.load();
let books = classifier.classifyAll(catalogue.books());

if (madhhabFilter && madhhabFilter.length > 0) {
  books = books.filter((b) => madhhabFilter.includes(b.madhhab));
}

const downloaded = books.filter((b) => b.downloaded);
process.stdout.write(
  `library: ${catalogue.location.root}\n` +
    `books: ${books.length} in scope, ${downloaded.length} downloaded\n` +
    `index: ${indexDir ?? "(default data dir)"}\n\n`,
);

let done = 0;
const summary = buildIndex(books, {
  indexDir,
  force: flag("--force"),
  onProgress: (p) => {
    done++;
    if (p.error) process.stdout.write(`  [${done}/${books.length}] FAILED ${p.book_id}: ${p.error}\n`);
    else if (!p.skipped) process.stdout.write(`  [${done}/${books.length}] ${p.book_id} — ${p.pages} pages\n`);
  },
});

catalogue.close();

process.stdout.write(
  `\nindexed ${summary.books_indexed} books / ${summary.pages_indexed} pages in ${summary.elapsed_ms}ms\n` +
    `skipped ${summary.books_skipped}, failed ${summary.books_failed.length}\n` +
    `index generation ${summary.generation} at ${summary.index_path}\n`,
);
if (summary.books_failed.length > 0) {
  for (const f of summary.books_failed) process.stdout.write(`  failed: ${f.book_id} — ${f.error}\n`);
}
