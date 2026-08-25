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

const { acquireEngine, selectBooks, allBooks, resetContext } = await import("../dist/context.js");
const { runBatchedSearch } = await import("../dist/pipeline/search.js");
const { discoverIssue } = await import("../dist/pipeline/discoverIssue.js");
const { exportResults } = await import("../dist/pipeline/exportResults.js");
const { parseQuery } = await import("../dist/search/query.js");
const { LuceneTextSource } = await import("../dist/shamela/luceneText.js");
const { MADHHABS } = await import("../dist/classify/types.js");

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
const handle = await acquireEngine();
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
  `corpus: ${report.corpus.books_downloaded} downloaded books ` +
    `(${report.corpus.books_in_catalogue} in catalogue) / ` +
    `${report.corpus.pages_in_shamela_index} pages in Shamela's index\n\n`,
);

// ── single-batch search latency ─────────────────────────────────────────────
for (const q of QUERIES) {
  const parsed = parseQuery(q.query, q.mode);
  const ids = books.map((b) => b.book_id).sort();
  const counts = await handle.engine.countsByBook(parsed, ids);
  const totalHits = counts.counts.reduce((n, c) => n + c.hits, 0);

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
        query: q.query, mode: q.mode,
        books: selectBooks({ madhhabs: [...MADHHABS] }), requested: MADHHABS,
        engine: handle.engine, limit: 25, pageSample: 10,
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

handle.release();

// ── the cost of a tool call, and the size of its answer ─────────────────────
//
// Everything above runs against an engine the harness already opened, so none
// of it can see what a *tool call* costs. That is the number a user feels: a
// call used to start a JVM and open an index of millions of documents before
// reading a posting, and to resolve its passages' text one round trip at a
// time. Both are measured here by driving the real MCP surface, with the
// helper's idle timeout as the only difference between the two runs — 0
// reproduces the old close-after-every-call behaviour exactly.
{
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { registerAllTools } = await import("../dist/server/registerTools.js");

  const q = QUERIES[0];
  const CALLS = 6;

  async function runCalls(idleMs) {
    process.env.FIQH4_ENGINE_IDLE_MS = String(idleMs);
    resetContext();

    const server = new McpServer({ name: "shamela-fiqh-4", version: "0.1.0" });
    registerAllTools(server);
    const client = new Client({ name: "bench", version: "1.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const call = (name, args) => client.callTool({ name, arguments: args });
    // One warm-up call, so neither run is charged for first-touch page cache.
    await call("fiqh4_search", { query: q.query, match_mode: q.mode, limit: 5 });

    const samples = [];
    let last = null;
    for (let i = 0; i < CALLS; i++) {
      const t0 = performance.now();
      last = await call("fiqh4_search", {
        query: q.query,
        match_mode: q.mode,
        limit: 20,
        include_full_text: true,
      });
      samples.push(performance.now() - t0);
    }
    await client.close();
    resetContext();
    return { stats: stats(samples), payload: last?.structuredContent ?? {} };
  }

  const perCall = await runCalls(0);
  const persistent = await runCalls(300_000);

  // What the moved constants used to cost. The change was a pure removal, so
  // re-adding them to the measured payload gives the old size exactly.
  const passages = persistent.payload.passages ?? [];
  const notes = persistent.payload.notes ?? {};
  const repeated = passages.reduce(
    (n, p) =>
      n +
      Buffer.byteLength(
        JSON.stringify({
          query: notes.query ?? "",
          match_mode: notes.match_mode ?? "",
          numbering_note: notes.numbering_note_ar ?? "",
          content_trust: notes.content_trust ?? "",
        }),
        "utf8",
      ) - 2,
    0,
  );
  const nowBytes = Buffer.byteLength(JSON.stringify(persistent.payload), "utf8");

  report.tool_call = {
    query: q.query,
    calls: CALLS,
    engine_opened_per_call_ms: perCall.stats,
    engine_persisted_ms: persistent.stats,
    speedup: Math.round((perCall.stats.p50 / persistent.stats.p50) * 100) / 100,
  };
  report.response_size = {
    passages: passages.length,
    bytes_now: nowBytes,
    bytes_with_repeated_constants: nowBytes + repeated,
    bytes_saved: repeated,
    percent_saved: Math.round((repeated / (nowBytes + repeated)) * 1000) / 10,
  };

  process.stdout.write(
    `\ntool call (fiqh4_search, limit 20, full text), p50 over ${CALLS} calls:\n` +
      `        engine opened per call : ${perCall.stats.p50}ms (p95 ${perCall.stats.p95})\n` +
      `        engine persisted       : ${persistent.stats.p50}ms (p95 ${persistent.stats.p95})` +
      `  — ${report.tool_call.speedup}× faster\n`,
  );
  process.stdout.write(
    `response size: ${passages.length} passages, ${nowBytes} bytes ` +
      `(was ${nowBytes + repeated}, −${repeated} = −${report.response_size.percent_saved}%)\n`,
  );
}

process.stdout.write(`\n--- machine-readable ---\n${JSON.stringify(report, null, 2)}\n`);
