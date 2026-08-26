#!/usr/bin/env node
/**
 * Open one of Shamela's own Lucene indexes and describe it.
 *
 * Shamela 4 keeps book text in Lucene under database/store — store/page holds
 * every page body, store/title every heading. Reading that index is the only
 * way to reach the text, and doing it safely starts with knowing its shape.
 *
 * The index is opened READ-ONLY: a Lucene DirectoryReader never writes and
 * never takes the write lock, so this cannot disturb a running Shamela.
 *
 * Field VALUES are not printed — only which fields exist, how they are indexed,
 * and how long their values are. Numeric fields are shown because an id is an
 * identifier, not content.
 *
 * Usage:
 *   npm run build:java
 *   node scripts/inspect-shamela-index.mjs D:\shamela\database\store\page
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2];

if (!target) {
  process.stderr.write(
    "Pass the index directory:\n" +
      "  node scripts/inspect-shamela-index.mjs D:\\shamela\\database\\store\\page\n",
  );
  process.exit(1);
}

if (!existsSync(join(ROOT, "dist", "index.js"))) {
  process.stderr.write("dist/ not found — run `npm run build` first.\n");
  process.exit(1);
}

const { LuceneBridge, helperAvailable, helperClassesDir } = await import(
  "../dist/search/luceneBridge.js"
);
if (!helperAvailable()) {
  process.stderr.write(
    `Helper classes not found at ${helperClassesDir()}\nBuild them first:  npm run build:java\n`,
  );
  process.exit(1);
}

// The helper runs on Shamela's own Java with Shamela's own Lucene jars, so the
// install has to be located before anything can be opened — the same route the
// server itself takes.
const { locateLibrary, luceneDir, resolveJava } = await import("../dist/shamela/discover.js");
const loc = locateLibrary();
const java = resolveJava(loc.appDir);
const jars = luceneDir(loc.appDir);
if (!java.path || !jars) {
  process.stderr.write(
    `Could not find Shamela's Java or Lucene jars under ${loc.appDir}.\n` +
      `java tried: ${java.tried.join(", ")}\n`,
  );
  process.exit(1);
}

const bridge = new LuceneBridge(
  { javaPath: java.path, luceneDir: jars, storeDir: loc.storeDir },
  300_000,
);

try {
  const r = await bridge.send("inspect", { indexDir: target, sample: 3 });

  const w = (s = "") => process.stdout.write(s + "\n");
  w("═══ Shamela Lucene index ═══");
  w(`path            : ${r.index_dir}`);
  w(`reader (ours)   : Lucene ${r.reader_lucene_version}`);

  if (r.error) {
    w("");
    w(`ERROR: ${r.error}`);
    w("");
    w("If this says the codec is unknown, the index was written by a newer");
    w("Lucene than this build. Raise <lucene.version> in java/pom.xml.");
    process.exit(2);
  }

  w(`documents       : ${r.num_docs} (max_doc ${r.max_doc}, deleted ${r.deleted_docs})`);
  w(`segments        : ${r.segments}`);
  w("");

  w("segments (sample):");
  for (const s of r.segment_sample ?? []) {
    w(`  ${String(s.name).padEnd(8)} codec=${String(s.codec).padEnd(12)} docs=${String(s.docs).padStart(9)}  written by ${s.created_by}`);
  }
  w("");

  w("fields:");
  w(`  ${"name".padEnd(16)} ${"indexed".padEnd(9)} ${"stored".padEnd(8)} ${"docvalues".padEnd(12)} index_options`);
  for (const f of r.fields ?? []) {
    w(
      `  ${String(f.name).padEnd(16)} ${String(f.indexed).padEnd(9)} ${String(f.stored).padEnd(8)} ` +
        `${String(f.doc_values).padEnd(12)} ${f.index_options}`,
    );
  }
  w("");

  w("sample documents (lengths only, no text):");
  for (const d of r.sample_docs ?? []) {
    w(`  doc ${d.doc}:`);
    for (const f of d.stored_fields ?? []) {
      const detail = f.type === "numeric" ? `= ${f.value}` : `${f.length} chars`;
      w(`      ${String(f.field).padEnd(16)} ${String(f.type).padEnd(8)} ${detail}`);
    }
  }
  w("");
  w("A field that is indexed but not stored can be searched, not displayed.");
  w("A field that is stored can be read back and quoted.");
} finally {
  await bridge.close();
}
