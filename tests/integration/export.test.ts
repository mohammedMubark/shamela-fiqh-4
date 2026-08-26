import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync as read } from "node:fs";
import { FIXTURE_MANIFEST } from "../helpers/paths.js";
import { acquireEngine, selectBooks, resetContext, type EngineHandle } from "../../src/context.js";
import { LuceneTextSource } from "../../src/shamela/luceneText.js";
import { exportResults } from "../../src/pipeline/exportResults.js";
import { Fiqh4Error } from "../../src/util/errors.js";

const fixtures = JSON.parse(read(FIXTURE_MANIFEST, "utf8")) as {
  planted_phrases: Record<string, string>;
  books: Array<{ book_id: string; downloaded: boolean; planted: string[]; planted_pages: Record<string, number[]> }>;
};
const ALPHA = fixtures.planted_phrases["alpha"]!;

let handle: EngineHandle;
let text: LuceneTextSource;
let outRoot: string;

beforeAll(async () => {
  resetContext();
  handle = await acquireEngine();
  text = new LuceneTextSource(handle.engine);
  outRoot = mkdtempSync(join(tmpdir(), "fiqh4-export-"));
}, 120_000);
afterAll(() => {
  handle?.release();
  rmSync(outRoot, { recursive: true, force: true });
});

const scope = () => selectBooks({ downloadedOnly: true });

function countLines(path: string): number {
  const text = readFileSync(path, "utf8");
  return text.length === 0 ? 0 : text.trimEnd().split("\n").length;
}

describe("exhaustive export", () => {
  it("sweeps every book and writes one JSONL row per hit", async () => {
    const r = await exportResults({
      text,
      query: ALPHA,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      outputDir: outRoot,
      jobId: "full-sweep",
      concurrency: 4,
      includeFullText: true,
    });

    const expected = fixtures.books
      .filter((b) => b.downloaded && b.planted.includes("alpha"))
      .reduce((n, b) => n + (b.planted_pages["alpha"]?.length ?? 0), 0);

    expect(r.total_hits).toBe(expected);
    expect(countLines(join(r.output_path, "results.jsonl"))).toBe(expected);
    expect(r.by_book.filter((b) => b.hits > 0).length).toBeGreaterThan(1);
  });

  it("writes a manifest, a report and a checksum that actually verifies", async () => {
    const r = await exportResults({
      text,
      query: ALPHA,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      outputDir: outRoot,
      jobId: "checksum-job",
      concurrency: 2,
      includeFullText: false,
    });

    for (const name of ["results.jsonl", "manifest.json", "report.md"]) {
      expect(existsSync(join(r.output_path, name))).toBe(true);
      expect(r.files.some((f) => f.name === name)).toBe(true);
    }

    const actual = createHash("sha256")
      .update(readFileSync(join(r.output_path, "results.jsonl")))
      .digest("hex");
    expect(r.checksum).toBe(actual);

    for (const f of r.files) {
      const onDisk = createHash("sha256").update(readFileSync(join(r.output_path, f.name))).digest("hex");
      expect(f.sha256).toBe(onDisk);
    }

    const manifest = JSON.parse(readFileSync(join(r.output_path, "manifest.json"), "utf8"));
    expect(manifest.query).toBe(ALPHA);
    expect(manifest.normalizer_version).toBe("shamela-compat-1");
    expect(manifest.index_fingerprint).toBe(r.index_fingerprint);
    expect(Array.isArray(manifest.notes_ar)).toBe(true);
  });

  it("attributes every exported row and never fabricates a page number", async () => {
    const r = await exportResults({
      text,
      query: ALPHA,
      mode: "phrase",
      books: scope(),
      engine: handle.engine,
      outputDir: outRoot,
      jobId: "attribution",
      concurrency: 2,
      includeFullText: false,
    });

    const rows = readFileSync(join(r.output_path, "results.jsonl"), "utf8")
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));

    for (const row of rows) {
      expect(row.book_id).toBeTruthy();
      expect(row.madhhab).toBeTruthy();
      expect(typeof row.page_id).toBe("number");
      expect(row.query).toBe(ALPHA);
      expect(row.content_trust).toBe("untrusted_source_text");
      expect(row.numbering_note).toContain("المكتبة الشاملة");
      // printed_page is either a real number or explicitly null.
      expect(row.printed_page === null || typeof row.printed_page === "number").toBe(true);
    }
  });

  it("records undownloaded books as skipped, with a reason", async () => {
    const r = await exportResults({
      text,
      query: ALPHA,
      mode: "phrase",
      books: selectBooks({}), // includes the undownloaded ones
      engine: handle.engine,
      outputDir: outRoot,
      jobId: "skipped-job",
      concurrency: 2,
      includeFullText: false,
    });
    expect(r.skipped_books.length).toBeGreaterThan(0);
    for (const s of r.skipped_books) expect(s.reason.length).toBeGreaterThan(0);
  });

  it("produces identical output regardless of concurrency", async () => {
    const a = await exportResults({
      text, query: ALPHA, mode: "phrase", books: scope(), engine: handle.engine,
      outputDir: outRoot, jobId: "conc-1", concurrency: 1, includeFullText: false,
    });
    const b = await exportResults({
      text, query: ALPHA, mode: "phrase", books: scope(), engine: handle.engine,
      outputDir: outRoot, jobId: "conc-8", concurrency: 8, includeFullText: false,
    });
    expect(a.total_hits).toBe(b.total_hits);
    // Shards are concatenated in a deterministic book order, so the bytes match.
    expect(a.checksum).toBe(b.checksum);
  });
});

describe("checkpoint and resume", () => {
  it("resumes after an interruption without duplicating or losing rows", async () => {
    const jobId = "resume-job";

    // Complete run, kept as the reference.
    const reference = await exportResults({
      text, query: ALPHA, mode: "phrase", books: scope(), engine: handle.engine,
      outputDir: outRoot, jobId: "resume-reference", concurrency: 1, includeFullText: false,
    });

    // Simulate a crash partway: run, then delete some shards and their
    // checkpoint entries, as if those books had never finished.
    await exportResults({
      text, query: ALPHA, mode: "phrase", books: scope(), engine: handle.engine,
      outputDir: outRoot, jobId, concurrency: 1, includeFullText: false,
    });

    const jobDir = join(outRoot, jobId);
    const checkpointPath = join(jobDir, "checkpoint.json");
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
    const completed = Object.keys(checkpoint.completed);
    expect(completed.length).toBeGreaterThan(2);

    const dropped = completed.slice(0, 2);
    for (const id of dropped) {
      rmSync(join(jobDir, "parts", `${encodeURIComponent(id)}.jsonl`), { force: true });
      delete checkpoint.completed[id];
    }
    writeFileSync(checkpointPath, JSON.stringify(checkpoint), "utf8");
    const remaining = Object.keys(checkpoint.completed).length;

    const resumed = await exportResults({
      text, query: ALPHA, mode: "phrase", books: scope(), engine: handle.engine,
      outputDir: outRoot, jobId, concurrency: 1, includeFullText: false,
    });

    expect(resumed.resumed_from_checkpoint).toBe(true);
    expect(resumed.books_reused_from_checkpoint).toBe(remaining);
    // The end state is byte-identical to a clean full run: nothing duplicated,
    // nothing lost.
    expect(resumed.total_hits).toBe(reference.total_hits);
    expect(resumed.checksum).toBe(reference.checksum);
  });

  it("discards a half-written shard rather than appending to it", async () => {
    const jobId = "partial-shard";
    await exportResults({
      text, query: ALPHA, mode: "phrase", books: scope(), engine: handle.engine,
      outputDir: outRoot, jobId, concurrency: 1, includeFullText: false,
    });

    const jobDir = join(outRoot, jobId);
    const checkpoint = JSON.parse(readFileSync(join(jobDir, "checkpoint.json"), "utf8"));
    const victim = Object.keys(checkpoint.completed).find((id) => checkpoint.completed[id] > 0)!;
    const shard = join(jobDir, "parts", `${encodeURIComponent(victim)}.jsonl`);

    // Truncate the shard and forget it ever completed — the interrupted case.
    writeFileSync(shard, readFileSync(shard, "utf8").split("\n").slice(0, 1).join("\n") + "\n", "utf8");
    delete checkpoint.completed[victim];
    writeFileSync(join(jobDir, "checkpoint.json"), JSON.stringify(checkpoint), "utf8");

    const again = await exportResults({
      text, query: ALPHA, mode: "phrase", books: scope(), engine: handle.engine,
      outputDir: outRoot, jobId, concurrency: 1, includeFullText: false,
    });

    const rows = readFileSync(join(again.output_path, "results.jsonl"), "utf8").trimEnd().split("\n");
    const keys = rows.map((l) => {
      const r = JSON.parse(l);
      return `${r.book_id}#${r.page_id}`;
    });
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("refuses to resume a job under a different query", async () => {
    const jobId = "mismatch-job";
    await exportResults({
      text, query: ALPHA, mode: "phrase", books: scope(), engine: handle.engine,
      outputDir: outRoot, jobId, concurrency: 1, includeFullText: false,
    });

    await expect(
      exportResults({
        text,
        query: fixtures.planted_phrases["beta"]!,
        mode: "phrase", books: scope(), engine: handle.engine,
        outputDir: outRoot, jobId, concurrency: 1, includeFullText: false,
      }),
    ).rejects.toThrow(Fiqh4Error);
  });

  it("rejects a job id that could escape the output directory", async () => {
    await expect(
      exportResults({
        text, query: ALPHA, mode: "phrase", books: scope(), engine: handle.engine,
        outputDir: outRoot, jobId: "../escape", concurrency: 1, includeFullText: false,
      }),
    ).rejects.toThrow(/UNSAFE_OUTPUT_PATH/);
  });

  it("keeps everything it writes inside the job directory", async () => {
    const r = await exportResults({
      text, query: ALPHA, mode: "phrase", books: scope(), engine: handle.engine,
      outputDir: outRoot, jobId: "contained", concurrency: 2, includeFullText: false,
    });
    expect(r.output_path.startsWith(outRoot)).toBe(true);
    const entries = readdirSync(r.output_path).sort();
    expect(entries).toEqual(["checkpoint.json", "manifest.json", "parts", "report.md", "results.jsonl"]);
  });
});
