#!/usr/bin/env node
/**
 * Acceptance smoke for an unpacked MCPB against a REAL Shamela installation.
 *
 * Everything else in this repository is tested against synthetic fixtures. This
 * is the one check that proves the shipped package works on a real library —
 * which matters because the fixtures once encoded an architecture no real
 * install has, and a full green suite said nothing about it.
 *
 * It deliberately avoids a full export: the point is package launch, tools/list,
 * guide, health, one real limited search, a resolvable citation, and a
 * four-madhhab discovery — each behind a latency gate, since reads turn very
 * slow while Shamela is rebuilding its indexes.
 *
 * Run it after `npm run pack` and unpacking, e.g.
 *   node scripts/smoke-real-package.mjs <unpacked>/dist/index.js
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = process.argv[2] ?? process.env.FIQH4_ENTRY;
const shamelaDir = process.env.FIQH4_SHAMELA_DIR ?? "D:\\shamela";

if (!entry || !existsSync(entry)) {
  process.stderr.write("Pass unpacked dist/index.js, or set FIQH4_ENTRY.\n");
  process.exit(1);
}
if (!existsSync(shamelaDir)) {
  process.stderr.write(`Shamela directory not found: ${shamelaDir}\n`);
  process.exit(1);
}

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) process.stdout.write(`  ok    ${label}\n`);
  else {
    failures++;
    process.stdout.write(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}\n`);
  }
}

const outputDir = join(process.cwd(), "tests", "fixtures", ".out-package-real-smoke");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: {
    ...process.env,
    FIQH4_SHAMELA_DIR: shamelaDir,
    FIQH4_OUTPUT_DIR: outputDir,
    FIQH4_LOG_LEVEL: "error",
  },
  stderr: "pipe",
});

const client = new Client({ name: "shamela-fiqh-4-package-real-smoke", version: "1.0.0" });

try {
  await client.connect(transport);
  process.stdout.write(`package real smoke — entry: ${entry}\n`);
  process.stdout.write(`library: ${shamelaDir}\n\n`);

  const { tools } = await client.listTools();
  check("tools/list exposes exactly 9 tools", tools.length === 9, `got ${tools.length}`);

  const guide = await client.callTool({ name: "fiqh4_guide", arguments: {} });
  check("fiqh4_guide succeeds", !guide.isError);

  const t0 = performance.now();
  const health = await client.callTool({ name: "fiqh4_health", arguments: {} });
  const healthMs = Math.round(performance.now() - t0);
  const hs = health.structuredContent ?? {};
  check("fiqh4_health succeeds", !health.isError);
  check("health uses lucene engine", hs.engines?.active === "lucene");
  check("health reads Shamela's own index", hs.index?.source === "shamela");
  check("health reports page documents", Number(hs.index?.page_documents) > 0);
  check("no derived index was built", hs.index?.readable === true);
  check("cold health is within 20s gate", healthMs <= 20_000, `${healthMs}ms`);

  const t1 = performance.now();
  const search = await client.callTool({
    name: "fiqh4_search",
    arguments: { query: "الطهارة", match_mode: "all_terms", limit: 5 },
  });
  const searchMs = Math.round(performance.now() - t1);
  const passages = search.structuredContent?.passages ?? [];
  check("real search succeeds", !search.isError, search.structuredContent?.error?.message_ar);
  check("real search returns at least one passage", passages.length > 0);
  check("real search has exact total", typeof search.structuredContent?.batch?.total_hits === "number");
  check("warm limited search is within 5s gate", searchMs <= 5_000, `${searchMs}ms`);

  if (passages.length > 0) {
    const first = passages[0];
    const cite = await client.callTool({
      name: "fiqh4_citation",
      arguments: { book_id: first.book_id, page_id: first.page_id },
    });
    check("citation for first real hit succeeds", !cite.isError, cite.structuredContent?.error?.message_ar);
    check("citation resolves same book", cite.structuredContent?.citation?.book_id === first.book_id);
  }

  const t2 = performance.now();
  const discover = await client.callTool({
    name: "fiqh4_discover_issue",
    arguments: {
      query: "مسح الرأس الوضوء",
      match_mode: "all_terms",
      madhhabs: ["hanafi", "maliki", "shafii", "hanbali"],
      limit: 25,
      page_sample: 5,
    },
  });
  const discoverMs = Math.round(performance.now() - t2);
  check("real discover succeeds", !discover.isError, discover.structuredContent?.error?.message_ar);
  check("real discover scans four-madhhab scope within 30s gate", discoverMs <= 30_000, `${discoverMs}ms`);
} finally {
  await client.close().catch(() => {});
}

process.stdout.write(failures === 0 ? "\npackage real smoke PASSED\n" : `\npackage real smoke FAILED (${failures} checks)\n`);
process.exit(failures === 0 ? 0 : 1);
