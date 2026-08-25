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
import { execFileSync, spawnSync } from "node:child_process";
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

/**
 * Check the compiler before using it.
 *
 * Lucene 10.4's own class files are Java 21, so anything older cannot compile
 * against them — and `javac` then reports only "release version 21 not
 * supported", which does not say what it found or where it came from. A machine
 * commonly has an older JDK on PATH while a newer one sits in JAVA_HOME, so
 * both are worth naming.
 */
function checkJavac() {
  let version = null;
  try {
    // JDK 9+ prints the version to stdout, JDK 8 to stderr — read both, or the
    // check silently passes on exactly the old compilers it exists to catch.
    const res = spawnSync("javac", ["-version"], { encoding: "utf8" });
    if (res.error) throw res.error;
    version = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  } catch (e) {
    process.stderr.write(
      "javac was not found on PATH.\n\n" +
        "A full JDK 21+ is needed to BUILD the Lucene helper. It is not needed to run it:\n" +
        "the extension uses the Java that Shamela already ships.\n\n" +
        "If you would rather not install a JDK, use a prebuilt shamela-fiqh-4.mcpb instead.\n",
    );
    process.exit(1);
  }

  // "javac 21.0.10" → 21. A 1.x form (JDK 8's "javac 1.8.0_392") means 8.
  const raw = /javac\s+(\d+)(?:\.(\d+))?/.exec(version);
  const major = raw ? (raw[1] === "1" ? Number(raw[2] ?? 0) : Number(raw[1])) : 0;
  if (major === 0) {
    process.stdout.write(`could not parse javac version from ${JSON.stringify(version)}; continuing\n`);
  }
  if (major && major < 21) {
    process.stderr.write(
      `javac is too old: found "${version}", need 21 or newer.\n\n` +
        `Lucene 10.4 — the version Shamela ships — is compiled for Java 21, so an\n` +
        `older compiler cannot build against it.\n\n` +
        (process.env.JAVA_HOME ? `JAVA_HOME is currently: ${process.env.JAVA_HOME}\n` : "") +
        `Install a JDK 21+ (for example Temurin 21) and make sure its bin/ comes\n` +
        `first on PATH, or point JAVA_HOME at it.\n\n` +
        `This is a BUILD-time requirement only. Running the extension uses the Java\n` +
        `that Shamela already ships under app/<os>/jre/2, so a prebuilt\n` +
        `shamela-fiqh-4.mcpb needs no JDK at all.\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`using ${version}\n`);
}

checkJavac();

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
