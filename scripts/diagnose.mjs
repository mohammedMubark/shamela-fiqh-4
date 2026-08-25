#!/usr/bin/env node
/**
 * One entry point for the diagnostics that identify an unfamiliar library.
 *
 * These exist because this project was built against an assumption that turned
 * out to be wrong for real installs, and the only way that was settled was by
 * measuring rather than guessing. They print structure — table and column
 * names, file sizes, Lucene field names — and never book text.
 *
 *   npm run fiqh4:diagnose -- schema  [path]   SQLite layout of master.db and books
 *   npm run fiqh4:diagnose -- lucene  [path]   Lucene codec and fields, without Java
 *   npm run fiqh4:diagnose -- index   <path>   open an index through the helper
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const [what, ...rest] = process.argv.slice(2);

const SCRIPTS = {
  schema: "dump-schema.mjs",
  lucene: "inspect-lucene.mjs",
  index: "inspect-shamela-index.mjs",
};

if (!what || !(what in SCRIPTS)) {
  process.stderr.write(
    "usage: npm run fiqh4:diagnose -- <schema|lucene|index> [path]\n\n" +
      "  schema   SQLite layout of master.db and a sample of book files\n" +
      "  lucene   Lucene codec generation and field names (no Java needed)\n" +
      "  index    open a Lucene index through the helper and describe it\n",
  );
  process.exit(what ? 1 : 0);
}

const res = spawnSync(process.execPath, [join(ROOT, "scripts", SCRIPTS[what]), ...rest], {
  stdio: "inherit",
});
process.exit(res.status ?? 1);
