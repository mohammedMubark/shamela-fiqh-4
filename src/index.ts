#!/usr/bin/env node
import { nodeVersionProblem } from "./util/preflight.js";

/**
 * Entry point, in two stages.
 *
 * Stage 1 — runs on whatever Node launched us: verify the version before
 * importing anything that reaches node:sqlite. On an old Node that import dies
 * with ERR_UNKNOWN_BUILTIN_MODULE and no hint of the fix, so the server body is
 * loaded *dynamically*, only after the check passes. The static import above is
 * safe: preflight.ts itself imports nothing.
 *
 * Stage 2 — src/server/main.ts, the actual server.
 *
 * All failure text goes to stderr, never stdout: stdout carries the JSON-RPC
 * stream, and one stray line there corrupts the session.
 */
const problem = nodeVersionProblem(process.versions.node);
if (problem) {
  process.stderr.write(`[shamela-fiqh-4] FATAL ${problem.en}\n[shamela-fiqh-4] ${problem.ar}\n`);
  process.exit(1);
}

const { runServer } = await import("./server/main.js");
runServer().catch((e: unknown) => {
  process.stderr.write(
    `[shamela-fiqh-4] FATAL ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`,
  );
  process.exit(1);
});
