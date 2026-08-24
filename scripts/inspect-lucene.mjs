#!/usr/bin/env node
/**
 * Identify a Lucene index without Java.
 *
 * Shamela 4 keeps book text in Lucene indexes under database/store, not in its
 * SQLite files. Before anything can read them we need two facts: which Lucene
 * codec wrote them (a reader can only open its own generation and usually one
 * before it), and what the fields are called.
 *
 * Both live in small metadata files — segments_N, *.si, *.fnm — so this reads
 * only those. It never opens *.fdt, which is where the text itself is: this
 * script reports structure, never content.
 *
 * Usage:
 *   node scripts/inspect-lucene.mjs D:\shamela\database\store\page
 *   node scripts/inspect-lucene.mjs D:\shamela\database\store        # all of them
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const target = process.argv[2];
if (!target || !existsSync(target)) {
  process.stderr.write(
    "Pass a Lucene index directory, e.g.\n" +
      "  node scripts/inspect-lucene.mjs D:\\shamela\\database\\store\\page\n",
  );
  process.exit(1);
}

/** Printable ASCII runs of >= 4 chars — codec names and field names are stored this way. */
function asciiStrings(buf, min = 4) {
  const out = [];
  let cur = "";
  for (const byte of buf) {
    if (byte >= 0x20 && byte <= 0x7e) {
      cur += String.fromCharCode(byte);
    } else {
      if (cur.length >= min) out.push(cur);
      cur = "";
    }
  }
  if (cur.length >= min) out.push(cur);
  return out;
}

/**
 * Codec and format classes are named Lucene90, Lucene99SegmentInfo,
 * Lucene101PostingsFormat … The digits after "Lucene" give the generation, so
 * match the prefix rather than the whole string — the suffix varies by format.
 */
function codecGeneration(name) {
  const m = /^Lucene(\d{2,3})/.exec(name);
  if (!m) return null;
  const digits = m[1];
  // Lucene84 → 8.4, Lucene99 → 9.9, Lucene101 → 10.1
  const major = digits.length === 3 ? Number(digits.slice(0, 2)) : Number(digits[0]);
  const minor = digits.length === 3 ? Number(digits.slice(2)) : Number(digits[1]);
  return { major, minor, label: `${major}.${minor}` };
}

function inspectIndex(dir) {
  const label = basename(dir);
  const out = [];
  const w = (s = "") => out.push(s);

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch (e) {
    return [`### ${label}`, `  cannot read: ${e.message}`, ""];
  }

  const files = entries.filter((e) => !e.isDirectory()).map((e) => e.name);
  const isLucene = files.some((f) => /^segments(_\w+)?$/.test(f));
  if (!isLucene) return [];

  let total = 0;
  const byExt = new Map();
  for (const f of files) {
    let size = 0;
    try {
      size = statSync(join(dir, f)).size;
    } catch { /* ignore */ }
    total += size;
    const ext = f.includes(".") ? f.slice(f.lastIndexOf(".")) : "(segments)";
    byExt.set(ext, (byExt.get(ext) ?? 0) + size);
  }

  w(`### ${label}`);
  w(`  path: ${dir}`);
  w(`  files: ${files.length}   total: ${(total / 1048576).toFixed(1)} MB`);
  const parts = [...byExt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  w(`  by type: ${parts.map(([e, s]) => `${e}=${(s / 1048576).toFixed(1)}MB`).join("  ")}`);

  // Codec generation, from segments_N and any .si files. These are tiny.
  const codecs = new Set();
  const metaFiles = files.filter((f) => /^segments(_\w+)?$/.test(f) || f.endsWith(".si"));
  for (const f of metaFiles.slice(0, 8)) {
    try {
      for (const s of asciiStrings(readFileSync(join(dir, f)))) {
        const m = /Lucene\d{2,3}[A-Za-z]*/.exec(s);
        if (m) codecs.add(m[0]);
      }
    } catch { /* ignore */ }
  }

  if (codecs.size === 0) {
    w("  codec: not identified from segments/.si");
  } else {
    const gens = [...codecs]
      .map((c) => ({ name: c, gen: codecGeneration(c) }))
      .filter((x) => x.gen);
    w(`  codec names: ${[...codecs].join(", ")}`);
    if (gens.length > 0) {
      const majors = [...new Set(gens.map((g) => g.gen.major))].sort((a, b) => a - b);
      w(`  → Lucene generation: ${gens.map((g) => g.gen.label).join(", ")}  (major ${majors.join("/")})`);
    }
  }

  // Field names from .fnm. Small files; they carry names, not values.
  const fieldFiles = files.filter((f) => f.endsWith(".fnm"));
  const fields = new Set();
  for (const f of fieldFiles.slice(0, 6)) {
    try {
      for (const s of asciiStrings(readFileSync(join(dir, f)), 2)) {
        // Skip the codec header and format markers.
        if (/^Lucene/.test(s) || /^[\x20-\x2f]+$/.test(s)) continue;
        if (/^[A-Za-z_][A-Za-z0-9_]{1,30}$/.test(s)) fields.add(s);
      }
    } catch { /* ignore */ }
  }
  w(`  field names: ${fields.size ? [...fields].join(", ") : "(none extracted)"}`);

  const fdt = files.filter((f) => f.endsWith(".fdt"));
  if (fdt.length > 0) {
    let stored = 0;
    for (const f of fdt) {
      try {
        stored += statSync(join(dir, f)).size;
      } catch { /* ignore */ }
    }
    w(`  stored fields (.fdt): ${(stored / 1048576).toFixed(1)} MB — the text itself lives here`);
  }
  w("");
  return out;
}

const lines = [];
lines.push("═══ Lucene index inspection ═══");
lines.push(`target: ${target}`);
lines.push("reads only segments/.si/.fnm metadata — never the stored text");
lines.push("");

const asIndex = inspectIndex(target);
if (asIndex.length > 0) {
  lines.push(...asIndex);
} else {
  // Not an index itself; treat it as a folder of indexes.
  let found = 0;
  for (const e of readdirSync(target, { withFileTypes: true, encoding: "utf8" })) {
    if (!e.isDirectory()) continue;
    const res = inspectIndex(join(target, e.name));
    if (res.length > 0) {
      found++;
      lines.push(...res);
    }
  }
  if (found === 0) lines.push("No Lucene index found here (looked for a segments file).");
}

lines.push("Reader compatibility: a Lucene release reads its own index generation");
lines.push("and, with backward-codecs, the one before it. Lucene 10 reads 9.x; it");
lines.push("cannot read 8.x or older.");

process.stdout.write(lines.join("\n") + "\n");
