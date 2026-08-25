#!/usr/bin/env node
/**
 * The published package must never contain Shamela's databases, book text, a
 * JRE, or Lucene jars. This checks both what git tracks and what `npm pack`
 * would ship.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BANNED_EXT = [".db", ".db-shm", ".db-wal", ".bok", ".jar", ".rar", ".mcpb"];
const BANNED_NAME = [/^master\.db$/i, /^jre\b/i, /^jdk\b/i, /lucene-.*\.jar$/i];
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const problems = [];

function check(files, label) {
  for (const f of files) {
    if (!f) continue;
    const lower = f.toLowerCase();
    if (BANNED_EXT.some((e) => lower.endsWith(e))) problems.push(`${label}: ${f} (banned extension)`);
    const base = f.split("/").pop() ?? f;
    if (BANNED_NAME.some((re) => re.test(base))) problems.push(`${label}: ${f} (banned filename)`);
    try {
      const size = statSync(join(ROOT, f)).size;
      if (size > MAX_FILE_BYTES) problems.push(`${label}: ${f} is ${(size / 1048576).toFixed(1)}MB — too large to ship`);
    } catch {
      /* not on disk (e.g. listed but ignored) */
    }
  }
}

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n");
check(tracked, "tracked by git");

// What npm would actually publish, per package.json "files".
let packed = [];
try {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  packed = (JSON.parse(out)[0]?.files ?? []).map((f) => f.path);
  check(packed, "in npm package");
} catch {
  process.stdout.write("  (npm pack --dry-run unavailable; checked tracked files only)\n");
}

// If a package has been built, inspect what it actually contains — that is the
// artefact users install, and it is the only check that covers what the packer
// decided to include. Vendor paths are exempt: a dependency shipping its own
// tests is its business, not a leak of ours.
const mcpb = join(ROOT, "shamela-fiqh-4.mcpb");
if (existsSync(mcpb)) {
  try {
    const listing = execFileSync("unzip", ["-Z1", mcpb], { encoding: "utf8" }).trim().split("\n");
    const ours = listing.filter((f) => f && !f.startsWith("node_modules/"));
    check(ours.map((f) => f), "in MCPB package");
    for (const f of ours) {
      // java/classes IS shipped: it is the compiled Lucene helper, a few
      // kilobytes of our own classes. What must never ship is Lucene itself, a
      // Java runtime, the helper's sources, or the test-only indexer — which is
      // the one piece of code here that can write to a Lucene index.
      if (/^java\/(src|testsrc|test-classes)\//.test(f)) {
        problems.push(`in MCPB package: ${f} (helper sources and test tooling must not ship)`);
      } else if (/^(tests|scripts|src|docs|\.github)\//.test(f)) {
        problems.push(`in MCPB package: ${f} (build-time file should not ship)`);
      }
      if (/fixture-manifest|master\.db/i.test(f)) {
        problems.push(`in MCPB package: ${f} (library or fixture data must not ship)`);
      }
    }
    const helper = ours.filter((f) => f.startsWith("java/classes/"));
    if (helper.length === 0) {
      problems.push("MCPB package has no java/classes — the Lucene helper is missing, so search cannot work");
    }
    process.stdout.write(
      `  MCPB package: ${listing.length} entries, ${ours.length} outside node_modules, ` +
        `${helper.length} helper classes\n`,
    );
  } catch {
    process.stdout.write("  (unzip unavailable; skipped MCPB inspection)\n");
  }
} else {
  process.stdout.write("  (no shamela-fiqh-4.mcpb built yet; skipped MCPB inspection)\n");
}

// The .gitignore must keep the obvious offenders out in the first place.
const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
for (const needed of ["*.db", "*.bok", "*.jar", "*.mcpb", "node_modules/", "dist/"]) {
  if (!ignore.includes(needed)) problems.push(`.gitignore is missing an entry for ${needed}`);
}

if (problems.length) {
  process.stderr.write("no-Shamela-data check FAILED:\n");
  for (const p of problems) process.stderr.write(`  - ${p}\n`);
  process.exit(1);
}
process.stdout.write(
  `no-Shamela-data check OK — ${tracked.length} tracked files, ${packed.length} packaged files, no databases, jars or JRE\n`,
);
