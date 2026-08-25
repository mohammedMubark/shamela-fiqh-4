#!/usr/bin/env node
/**
 * End-to-end smoke test against the BUILT server over a real stdio transport.
 *
 * The vitest suite drives the tools in-process; this proves the shipped
 * artefact works the way Claude Desktop will actually launch it — spawned as a
 * subprocess, speaking JSON-RPC on stdin/stdout.
 *
 * Runs against the synthetic fixtures unless FIQH4_SHAMELA_DIR says otherwise.
 */
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "dist", "index.js");

if (!existsSync(ENTRY)) {
  process.stderr.write("dist/index.js not found — run `npm run build` first.\n");
  process.exit(1);
}

const fixtures = join(ROOT, "tests", "fixtures", "generated");
const shamelaDir = process.env.FIQH4_SHAMELA_DIR ?? fixtures;

if (!existsSync(shamelaDir)) {
  process.stderr.write(`library not found at ${shamelaDir} — run \`npm run fixtures\` first.\n`);
  process.exit(1);
}

// Start from a clean output directory. Exports are resumable by design, so a
// checkpoint left by an earlier run would (correctly) be refused as belonging
// to a different query or index — which is the guard working, not a bug, but it
// makes the smoke test non-repeatable.
const outputDir = join(ROOT, "tests", "fixtures", ".out-smoke");
rmSync(outputDir, { recursive: true, force: true });

let failures = 0;
const check = (label, condition, detail = "") => {
  if (condition) {
    process.stdout.write(`  ok    ${label}\n`);
  } else {
    failures++;
    process.stdout.write(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}\n`);
  }
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [ENTRY],
  env: {
    ...process.env,
    FIQH4_SHAMELA_DIR: shamelaDir,
    FIQH4_OUTPUT_DIR: outputDir,
    FIQH4_LOG_LEVEL: "error",
  },
  stderr: "pipe",
});

const client = new Client({ name: "shamela-fiqh-4-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  process.stdout.write(`smoke test — library: ${shamelaDir}\n\n`);

  // ── handshake and surface ────────────────────────────────────────────────
  const { tools } = await client.listTools();
  check("server responds to tools/list", tools.length > 0);
  check("exposes exactly 9 tools", tools.length === 9, `got ${tools.length}`);
  check("every tool uses the fiqh4_ prefix", tools.every((t) => t.name.startsWith("fiqh4_")));

  const callTool = async (name, args = {}) => client.callTool({ name, arguments: args });

  // ── health ───────────────────────────────────────────────────────────────
  const health = await callTool("fiqh4_health");
  check("fiqh4_health succeeds", !health.isError);
  const hs = health.structuredContent ?? {};
  check("health reports read-only access", hs.library?.access_mode === "read-only");
  check("health finds Shamela's page index", hs.index?.page_index === true);
  check("health reads that index", hs.index?.readable === true);
  check("no derived index is built", hs.index?.source === "shamela");
  check("search runs on Shamela's own Java and Lucene", Boolean(hs.engines?.java_path && hs.engines?.lucene_dir));

  // ── guide ────────────────────────────────────────────────────────────────
  const guide = await callTool("fiqh4_guide");
  check("fiqh4_guide succeeds", !guide.isError);
  check(
    "guide states it does not issue rulings",
    (guide.structuredContent?.limits_ar ?? []).join(" ").includes("لا تُصدر فتوى"),
  );

  // ── books ────────────────────────────────────────────────────────────────
  const books = await callTool("fiqh4_list_books", { limit: 5 });
  check("fiqh4_list_books returns books", (books.structuredContent?.books ?? []).length > 0);
  check(
    "each book carries classification provenance",
    (books.structuredContent?.books ?? []).every((b) => b.classification_source && b.verification_status),
  );

  // ── search ───────────────────────────────────────────────────────────────
  const probeTerm =
    hs.library?.root === fixtures ? "مسألة الزاوية الأولى في الترتيب المعياري" : "الطهارة";
  const search = await callTool("fiqh4_search", { query: probeTerm, match_mode: "phrase", limit: 3 });
  check("fiqh4_search succeeds", !search.isError, search.structuredContent?.error?.message_en);
  const batch = search.structuredContent?.batch ?? {};
  check("search reports an exact total", typeof batch.total_hits === "number" && batch.total_hits_exact === true);
  check("search declares truncation explicitly", typeof batch.truncated === "boolean");
  // The default scope is the four schools, and the response says which books it
  // searched and which it left out — an empty result must never be ambiguous
  // between "nothing matched" and "nothing was searched".
  const cov = search.structuredContent?.coverage ?? {};
  check(
    "search defaults to the four madhhabs",
    JSON.stringify((cov.madhhabs_requested ?? []).slice().sort()) ===
      JSON.stringify(["hanafi", "hanbali", "maliki", "shafii"]),
  );
  check(
    "search reports coverage for every school it was asked about",
    (cov.by_madhhab ?? []).length >= 4 && typeof cov.books_not_downloaded_total === "number",
  );

  // ── two-phase workflow ───────────────────────────────────────────────────
  const discover = await callTool("fiqh4_discover_issue", {
    query: probeTerm,
    match_mode: "phrase",
    limit: 5,
    page_sample: 3,
  });
  check("fiqh4_discover_issue succeeds", !discover.isError);
  const found = discover.structuredContent?.books ?? [];
  check("discover locates at least one book", found.length > 0);

  if (found.length > 0) {
    const fetched = await callTool("fiqh4_fetch_passages", {
      query: probeTerm,
      match_mode: "phrase",
      requests: [{ book_id: found[0].book_id, page_ids: found[0].page_ids.slice(0, 2) }],
      neighbors: 1,
    });
    const passages = fetched.structuredContent?.passages ?? [];
    check("fiqh4_fetch_passages returns text", passages.length > 0);
    // The book databases hold no text at all, so any text here came from Lucene.
    check("that text came from Shamela's Lucene index", passages.some((p) => (p.text_original ?? "").length > 0));
    // Stated once for the response rather than repeated inside every passage:
    // it is the same sentence about the same batch either way.
    check(
      "passages are marked as untrusted source text",
      fetched.structuredContent?.notes?.content_trust === "untrusted_source_text",
    );

    const cite = await callTool("fiqh4_citation", {
      book_id: found[0].book_id,
      page_id: found[0].page_ids[0],
    });
    check("fiqh4_citation succeeds", !cite.isError);
    check("citation declares Shamela numbering", cite.structuredContent?.citation?.numbering_authority === "shamela");
    check("citation never invents an edition", cite.structuredContent?.citation?.edition === null);
  }

  const compare = await callTool("fiqh4_compare_issue", { query: probeTerm, match_mode: "phrase", per_madhhab_limit: 2 });
  check("fiqh4_compare_issue succeeds", !compare.isError);
  check(
    "comparison carries the no-fatwa disclaimer",
    (compare.structuredContent?.disclaimer_ar ?? "").includes("لا تُصدر حكمًا فقهيًا"),
  );

  // ── export, including the path guard ─────────────────────────────────────
  const exported = await callTool("fiqh4_export_results", {
    query: probeTerm,
    match_mode: "phrase",
    job_id: "smoke-export",
    include_full_text: false,
  });
  check(
    "fiqh4_export_results writes an export",
    !exported.isError,
    exported.structuredContent?.error?.message_en ?? exported.structuredContent?.error?.message_ar,
  );
  check("export returns a sha256 checksum", /^[0-9a-f]{64}$/.test(exported.structuredContent?.checksum ?? ""));

  const escape = await callTool("fiqh4_export_results", {
    query: probeTerm,
    match_mode: "phrase",
    job_id: "smoke-escape",
    output_dir: "/etc",
  });
  check("export refuses a path outside the output root", escape.isError === true);

  // ── typed errors ─────────────────────────────────────────────────────────
  const badQuery = await callTool("fiqh4_search", { query: "؟!،" });
  check("an empty query returns a typed error", badQuery.structuredContent?.error?.code === "INVALID_QUERY");
} finally {
  await client.close().catch(() => {});
}

process.stdout.write(failures === 0 ? "\nsmoke test PASSED\n" : `\nsmoke test FAILED (${failures} checks)\n`);
process.exit(failures === 0 ? 0 : 1);
