#!/usr/bin/env node
/**
 * Measures latency, memory and completeness.
 *
 * Runs against the synthetic fixtures by default; pass --real (or set
 * FIQH4_SHAMELA_DIR) to measure a genuine library. Numbers printed here are the
 * ones that belong in docs/BENCHMARKS.md — no figure should appear in that file
 * that this script did not produce on a stated machine.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cpus, totalmem } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(ROOT, "dist", "index.js"))) {
  process.stderr.write("dist/ not found — run `npm run build` first.\n");
  process.exit(1);
}

const real = process.argv.includes("--real");
if (!real && !process.env.FIQH4_SHAMELA_DIR) {
  process.env.FIQH4_SHAMELA_DIR = join(ROOT, "tests", "fixtures", "generated");
}

const { openEngine, selectBooks, allBooks, resetContext } = await import("../dist/context.js");
const { runBatchedSearch } = await import("../dist/pipeline/search.js");
const { discoverIssue } = await import("../dist/pipeline/discoverIssue.js");
const { exportResults } = await import("../dist/pipeline/exportResults.js");
const { parseQuery } = await import("../dist/search/query.js");
const { LuceneTextSource } = await import("../dist/shamela/luceneText.js");

function rssMb() {
  return Math.round((process.memoryUsage().rss / 1048576) * 10) / 10;
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    n: s.length,
    min: Math.round(s[0] * 100) / 100,
    p50: Math.round(at(50) * 100) / 100,
    p95: Math.round(at(95) * 100) / 100,
    max: Math.round(s[s.length - 1] * 100) / 100,
  };
}

async function timeIt(fn, runs) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return stats(samples);
}

resetContext();
const handle = await openEngine();
const text = new LuceneTextSource(handle.engine);
const books = selectBooks({ downloadedOnly: true });
const catalogue = allBooks();

const QUERIES = real
  ? [
      { label: "phrase (شائعة)", query: "لا يجوز بيع الغرر", mode: "phrase" },
      { label: "all_terms", query: "مسح الرأس الوضوء", mode: "all_terms" },
      { label: "any_terms", query: "الطهارة النجاسة", mode: "any_terms" },
    ]
  : [
      { label: "phrase", query: "مسألة الزاوية الأولى في الترتيب المعياري", mode: "phrase" },
      { label: "all_terms", query: "قاعدة الميزان الثاني عند التقدير", mode: "all_terms" },
      { label: "any_terms", query: "ضابط النسبة الثالثة في التقسيم", mode: "any_terms" },
    ];

const report = {
  measured_at: new Date().toISOString(),
  mode: real ? "real-library" : "synthetic-fixtures",
  machine: {
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    cpu: cpus()[0]?.model ?? "unknown",
    cpu_count: cpus().length,
    total_memory_gb: Math.round((totalmem() / 1073741824) * 10) / 10,
  },
  corpus: {
    books_in_catalogue: catalogue.length,
    books_downloaded: books.length,
    pages_in_shamela_index: handle.engine.indexStats?.pageDocs ?? 0,
  },
  engine: handle.id,
  rss_after_open_mb: rssMb(),
  searches: [],
  paging: null,
  discovery: null,
  export: null,
};

process.stdout.write(`benchmark — ${report.mode}, engine ${report.engine}\n`);
process.stdout.write(
  `corpus: ${report.corpus.books_downloaded} books / ${report.corpus.pages_in_shamela_index} pages\n\n`,
);

// ── single-batch search latency ─────────────────────────────────────────────
for (const q of QUERIES) {
  const parsed = parseQuery(q.query, q.mode);
  const ids = books.map((b) => b.book_id).sort();
  const counts = await handle.engine.countsByBook(parsed, ids);
  const totalHits = counts.reduce((n, c) => n + c.hits, 0);

  const latency = await timeIt(
    () =>
      runBatchedSearch({
        text,
        query: q.query,
        mode: q.mode,
        books,
        engine: handle.engine,
        limit: 20,
        includeFullText: false,
        byteBudget: 262_144,
      }),
    real ? 10 : 30,
  );

  report.searches.push({ ...q, total_hits: totalHits, latency_ms: latency });
  process.stdout.write(
    `search ${q.label.padEnd(18)} hits=${String(totalHits).padStart(7)}  ` +
      `p50=${latency.p50}ms p95=${latency.p95}ms max=${latency.max}ms\n`,
  );
}

// ── exhaustive paging: completeness + flat memory ───────────────────────────
{
  const q = QUERIES[0];
  const rssBefore = rssMb();
  let peak = rssBefore;
  const seen = new Set();
  let cursor = null;
  let batches = 0;
  let total = null;

  const t0 = performance.now();
  do {
    const r = await runBatchedSearch({
      text, query: q.query, mode: q.mode, books, engine: handle.engine,
      limit: 50, cursor, includeFullText: false, byteBudget: 1_000_000,
    });
    total ??= r.batch.total_hits;
    for (const p of r.passages) seen.add(`${p.book_id}#${p.page_id}`);
    cursor = r.batch.next_cursor;
    batches++;
    peak = Math.max(peak, rssMb());
  } while (cursor && batches < 100_000);
  const elapsed = performance.now() - t0;

  report.paging = {
    query: q.query,
    total_hits: total,
    unique_hits_collected: seen.size,
    complete: seen.size === total,
    batches,
    batch_size: 50,
    elapsed_ms: Math.round(elapsed),
    ms_per_batch: Math.round((elapsed / batches) * 100) / 100,
    rss_before_mb: rssBefore,
    rss_peak_mb: peak,
    rss_growth_mb: Math.round((peak - rssBefore) * 10) / 10,
  };
  process.stdout.write(
    `\npaging: ${batches} batches, ${seen.size}/${total} hits ` +
      `(complete=${seen.size === total}), ${Math.round(elapsed)}ms, ` +
      `RSS ${rssBefore}→${peak}MB (+${report.paging.rss_growth_mb})\n`,
  );
}

// ── discovery ───────────────────────────────────────────────────────────────
{
  const q = QUERIES[0];
  const latency = await timeIt(
    () =>
      discoverIssue({
        query: q.query, mode: q.mode, books: selectBooks({}), engine: handle.engine,
        limit: 25, pageSample: 20,
      }),
    real ? 5 : 20,
  );
  report.discovery = { query: q.query, latency_ms: latency };
  process.stdout.write(`discovery: p50=${latency.p50}ms p95=${latency.p95}ms\n`);
}

// ── full export ─────────────────────────────────────────────────────────────
{
  const q = QUERIES[0];
  const outDir = join(ROOT, "bench-out");
  const rssBefore = rssMb();
  const t0 = performance.now();
  const r = await exportResults({
    text, query: q.query, mode: q.mode, books, engine: handle.engine,
    outputDir: outDir, jobId: `bench-${Date.now()}`, concurrency: 4, includeFullText: true,
  });
  const elapsed = performance.now() - t0;
  const rssAfter = rssMb();

  report.export = {
    query: q.query,
    total_hits: r.total_hits,
    books_swept: r.by_book.length,
    elapsed_ms: Math.round(elapsed),
    hits_per_second: Math.round((r.total_hits / (elapsed / 1000)) * 10) / 10,
    rss_before_mb: rssBefore,
    rss_after_mb: rssAfter,
    rss_growth_mb: Math.round((rssAfter - rssBefore) * 10) / 10,
    output_bytes: r.files.reduce((n, f) => n + f.bytes, 0),
  };
  process.stdout.write(
    `export: ${r.total_hits} hits from ${r.by_book.length} books in ${Math.round(elapsed)}ms ` +
      `(${report.export.hits_per_second}/s), RSS ${rssBefore}→${rssAfter}MB\n`,
  );
  process.stdout.write(`        wrote ${(report.export.output_bytes / 1024).toFixed(1)}KB to ${r.output_path}\n`);
}

handle.engine.close();

process.stdout.write(`\n--- machine-readable ---\n${JSON.stringify(report, null, 2)}\n`);
