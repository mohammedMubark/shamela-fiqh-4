#!/usr/bin/env node
/**
 * The extension must not open a socket or reach the network at runtime.
 *
 * Scans src/ for imports of networking modules. The MCP SDK ships HTTP and SSE
 * transports as dependencies; that is unavoidable and harmless as long as we
 * never import them, which is exactly what this checks.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

const FORBIDDEN = [
  { pattern: /from\s+["'](node:)?(http|https|net|tls|dgram|http2)["']/, why: "network core module" },
  { pattern: /require\(\s*["'](node:)?(http|https|net|tls|dgram|http2)["']\s*\)/, why: "network core module" },
  { pattern: /\bfetch\s*\(/, why: "fetch() call" },
  { pattern: /\bnew\s+WebSocket\b/, why: "WebSocket" },
  { pattern: /\bXMLHttpRequest\b/, why: "XMLHttpRequest" },
  // Anchored to module specifiers: matching these names in free prose would
  // flag words like "expression" and "honouring".
  { pattern: /from\s+["'][^"']*(streamableHttp|\/sse\.js|webStandardStreamableHttp)["']/, why: "HTTP/SSE MCP transport" },
  { pattern: /from\s+["'](express|hono|@hono\/[^"']*|ws|undici|axios|node-fetch|got)["']/, why: "HTTP client or server framework" },
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (extname(full) === ".ts") out.push(full);
  }
  return out;
}

const problems = [];
for (const file of walk(SRC)) {
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    // Comments explaining why we avoid these are not violations.
    const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(code)) {
        problems.push(`${relative(ROOT, file)}:${i + 1} — ${why}: ${line.trim()}`);
      }
    }
  });
}

if (problems.length) {
  process.stderr.write("network-free check FAILED:\n");
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}
process.stdout.write("network-free check OK — src/ imports no networking module and makes no outbound call\n");
