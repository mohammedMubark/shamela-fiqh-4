#!/usr/bin/env node
/**
 * Fetch lucene-core from Maven Central so the helper can be COMPILED.
 *
 * Compiling needs Lucene on the classpath, and CI has no Shamela installation
 * to borrow it from. The alternative — committing Apache's jar to this
 * repository — would mean redistributing a binary this project has no need to
 * ship.
 *
 * This is a build-time download only and does not weaken the offline
 * guarantee: nothing from the jar ends up in what is shipped. At runtime the
 * helper loads Lucene from the user's own Shamela install, and the packed
 * bundle contains our few kilobytes of compiled classes and no Lucene at all.
 *
 * The version must match what Shamela ships, so the classes we compile are
 * binary-compatible with the jars they will actually run against.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The version Shamela 4 bundles in app/lucene/2. */
export const LUCENE_VERSION = "10.4.0";
/**
 * `lucene-core` is what the shipped helper compiles against — it treats query
 * terms as exact and needs no analyzer. `lucene-analysis-common` is fetched
 * only for the test-only fixture indexer, which does need one. Neither is
 * shipped.
 */
const ARTIFACTS = [
  { id: "lucene-core", required: true },
  { id: "lucene-analysis-common", required: false },
];

export const JAR_DIR = join(ROOT, ".lucene-build");
export const JAR_PATH = join(JAR_DIR, `lucene-core-${LUCENE_VERSION}.jar`);

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Every fetched jar, as a classpath string. */
export async function ensureLuceneJars() {
  mkdirSync(JAR_DIR, { recursive: true });
  const paths = [];

  for (const { id } of ARTIFACTS) {
    const artifact = `${id}-${LUCENE_VERSION}.jar`;
    const target = join(JAR_DIR, artifact);
    if (existsSync(target)) {
      paths.push(target);
      continue;
    }
    const base = `https://repo1.maven.org/maven2/org/apache/lucene/${id}/${LUCENE_VERSION}`;
    process.stdout.write(`fetching ${artifact} (build-time only)…\n`);
    const jar = await download(`${base}/${artifact}`);

    // Verify against Maven's published checksum before trusting the bytes.
    const expected = (await download(`${base}/${artifact}.sha1`)).toString("utf8").trim().slice(0, 40);
    const actual = createHash("sha1").update(jar).digest("hex");
    if (expected && actual !== expected) {
      throw new Error(`checksum mismatch for ${artifact}: expected ${expected}, got ${actual}`);
    }
    writeFileSync(target, jar);
    process.stdout.write(`  ${target} (${(jar.length / 1048576).toFixed(1)} MB, sha1 ${actual})\n`);
    paths.push(target);
  }
  return paths;
}

/** The single jar the shipped helper compiles against. */
export async function ensureLuceneJar() {
  const [core] = await ensureLuceneJars();
  return core;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await ensureLuceneJars();
}
