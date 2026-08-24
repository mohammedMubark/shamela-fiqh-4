import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_MANIFEST, FIXTURE_ROOT, REPO_ROOT } from "../helpers/paths.js";
import { NodeSearchEngine } from "../../src/search/nodeEngine.js";
import { LuceneSearchEngine } from "../../src/search/luceneEngine.js";
import { parseQuery } from "../../src/search/query.js";
import type { AfterKey, EngineSearchResult, SearchEngine } from "../../src/search/engine.js";
import { TEST_INDEX_DIR } from "../helpers/paths.js";

/**
 * The two engines must return the same result set.
 *
 * The whole dual-backend design rests on this: a query means one thing, and
 * which backend answered it is an implementation detail the user should never
 * be able to detect in the results. Scores differ (bm25 implementations differ)
 * and so does relevance ORDER, but the SET of matching pages must be identical
 * — otherwise the optional backend silently changes what the corpus says.
 *
 * Skipped unless the jar has been built, since it is optional by design.
 */
const JAR = process.env["FIQH4_LUCENE_JAR"] ?? join(REPO_ROOT, "java", "target", "fiqh4-lucene-bridge.jar");
const HAVE_JAR = existsSync(JAR);

const fixtures = JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf8")) as {
  planted_phrases: Record<string, string>;
  books: Array<{ book_id: string; downloaded: boolean }>;
};

const LUCENE_INDEX_DIR = join(REPO_ROOT, "tests", "fixtures", ".index-lucene");

describe.skipIf(!HAVE_JAR)("Node and Lucene engines agree", () => {
  let node: NodeSearchEngine;
  let lucene: LuceneSearchEngine;

  beforeAll(async () => {
    rmSync(LUCENE_INDEX_DIR, { recursive: true, force: true });
    execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "build-lucene-index.mjs")], {
      cwd: REPO_ROOT,
      stdio: "pipe",
      env: {
        ...process.env,
        FIQH4_SHAMELA_DIR: FIXTURE_ROOT,
        FIQH4_INDEX_DIR: LUCENE_INDEX_DIR,
        FIQH4_LUCENE_JAR: JAR,
      },
    });
    process.env["FIQH4_LUCENE_JAR"] = JAR;
    node = NodeSearchEngine.open(TEST_INDEX_DIR);
    lucene = await LuceneSearchEngine.open(LUCENE_INDEX_DIR);
    await lucene.refreshBooks();
  }, 300_000);

  afterAll(() => {
    node?.close();
    lucene?.close();
    rmSync(LUCENE_INDEX_DIR, { recursive: true, force: true });
  });

  const downloaded = () => fixtures.books.filter((b) => b.downloaded).map((b) => b.book_id).sort();

  for (const [label, phrase, mode] of [
    ["phrase", fixtures.planted_phrases["alpha"]!, "phrase"],
    ["all_terms", fixtures.planted_phrases["beta"]!, "all_terms"],
    ["any_terms", fixtures.planted_phrases["gamma"]!, "any_terms"],
  ] as const) {
    it(`returns the same total for ${label}`, async () => {
      const q = parseQuery(phrase, mode);
      const ids = downloaded();
      const n = await node.search({ query: q, bookIds: ids, limit: 1, after: null });
      const l = await lucene.search({ query: q, bookIds: ids, limit: 1, after: null });
      expect(l.totalHits).toBe(n.totalHits);
    });

    it(`returns the same set of pages for ${label}`, async () => {
      const q = parseQuery(phrase, mode);
      const ids = downloaded();

      // Typed as the shared contract rather than the union of the two classes:
      // a union of method signatures defeats inference on the awaited result.
      const collect = async (engine: SearchEngine) => {
        const out = new Set<string>();
        let after: AfterKey | null = null;
        for (let guard = 0; guard < 1000; guard++) {
          const r: EngineSearchResult = await engine.search({
            query: q,
            bookIds: ids,
            limit: 50,
            after,
          });
          for (const h of r.hits) out.add(`${h.book_id}#${h.page_id}`);
          if (!r.hasMore || !r.after) break;
          after = r.after;
        }
        return out;
      };

      const a = await collect(node);
      const b = await collect(lucene);
      expect(b.size).toBe(a.size);
      expect([...b].sort()).toEqual([...a].sort());
    });
  }

  it("agrees on per-book hit counts", async () => {
    const q = parseQuery(fixtures.planted_phrases["alpha"]!, "phrase");
    const ids = downloaded();
    const n = await node.countsByBook(q, ids);
    const l = await lucene.countsByBook(q, ids);
    const norm = (rows: Array<{ book_id: string; hits: number }>) =>
      rows.filter((r) => r.hits > 0).map((r) => `${r.book_id}:${r.hits}`).sort();
    expect(norm(l)).toEqual(norm(n));
  });

  it("agrees on which pages of a book match", async () => {
    const q = parseQuery(fixtures.planted_phrases["alpha"]!, "phrase");
    const book = fixtures.books.find((b) => b.downloaded)!.book_id;
    const n = await node.pageIdsForBook(q, book, 500);
    const l = await lucene.pageIdsForBook(q, book, 500);
    expect(l).toEqual(n);
  });

  it("pages through Lucene searchAfter without duplicates or gaps", async () => {
    const q = parseQuery(fixtures.planted_phrases["alpha"]!, "phrase");
    const ids = downloaded();
    const seen = new Set<string>();
    let after: { score: number; doc: number } | null = null;
    let batches = 0;
    let total: number | null = null;

    for (; batches < 1000; batches++) {
      const r = await lucene.search({ query: q, bookIds: ids, limit: 7, after });
      total ??= r.totalHits;
      for (const h of r.hits) {
        const key = `${h.book_id}#${h.page_id}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      if (!r.hasMore || !r.after) break;
      after = r.after;
    }
    expect(seen.size).toBe(total);
    expect(batches).toBeGreaterThan(1);
  });

  it("produces a different fingerprint than the Node engine, so cursors never cross backends", () => {
    expect(lucene.fingerprint(downloaded())).not.toBe(node.fingerprint(downloaded()));
  });
});
