#!/usr/bin/env node
/**
 * Compile the Lucene helper.
 *
 * Produces class files under java/classes and nothing else. Lucene itself is a
 * compile-time classpath entry; at runtime the helper is launched with the jars
 * from the user's own Shamela install, so neither Lucene nor a JRE is ever
 * shipped or asked of the user.
 *
 * Compiling needs a full JDK. Shamela's bundled runtime is a trimmed JRE with
 * no `jdk.compiler`, which is exactly why the helper is compiled here and
 * shipped as classes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLuceneJars } from "./fetch-lucene.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "java", "src");
const OUT = join(ROOT, "java", "classes");
/** Test-only tooling, compiled separately and never packaged. */
const TEST_SRC = join(ROOT, "java", "testsrc");
const TEST_OUT = join(ROOT, "java", "test-classes");

const jars = await ensureLuceneJars();
// The shipped helper compiles against lucene-core alone; requiring more would
// mean it depends on jars Shamela might not ship.
const jar = jars[0];
const testClasspath = jars.join(process.platform === "win32" ? ";" : ":");

function javaSources(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...javaSources(full));
    else if (entry.name.endsWith(".java")) out.push(full);
  }
  return out;
}

const sources = javaSources(SRC);
if (sources.length === 0) {
  process.stderr.write(`no .java sources under ${SRC}\n`);
  process.exit(1);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

process.stdout.write(`compiling ${sources.length} sources → ${OUT}\n`);
try {
  execFileSync(
    "javac",
    [
      // Shamela's JRE is Java 21; targeting it keeps the classes loadable there.
      "--release", "21",
      "-encoding", "UTF-8",
      "-classpath", jar,
      "-d", OUT,
      ...sources,
    ],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
} catch (e) {
  process.stderr.write(`javac failed:\n${e.stderr ?? e.message}\n`);
  process.stderr.write("A full JDK 21+ is required to build (a JRE cannot compile).\n");
  process.exit(1);
}

// The fixture indexer is the only code in this repository that writes a Lucene
// index. It is compiled apart from the shipped helper so that the helper cannot
// write even by accident, and .mcpbignore keeps it out of the package.
if (existsSync(TEST_SRC)) {
  const testSources = javaSources(TEST_SRC);
  if (testSources.length > 0) {
    rmSync(TEST_OUT, { recursive: true, force: true });
    mkdirSync(TEST_OUT, { recursive: true });
    try {
      execFileSync(
        "javac",
        ["--release", "21", "-encoding", "UTF-8", "-classpath", testClasspath, "-d", TEST_OUT, ...testSources],
        { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
      );
      process.stdout.write(`compiled ${testSources.length} test tool(s) → ${TEST_OUT}\n`);
    } catch (e) {
      process.stderr.write(`javac failed for test tools:\n${e.stderr ?? e.message}\n`);
      process.exit(1);
    }
  }
}

let bytes = 0;
const count = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) count(full);
    else bytes += statSync(full).size;
  }
};
count(OUT);

process.stdout.write(
  `built ${(bytes / 1024).toFixed(1)} KB of classes — no Lucene, no JRE is shipped\n`,
);
if (!existsSync(join(OUT, "dev", "shamela", "fiqh4", "Main.class"))) {
  process.stderr.write("expected Main.class was not produced\n");
  process.exit(1);
}
