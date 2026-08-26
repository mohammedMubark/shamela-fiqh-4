import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { LuceneBridge } from "../../src/search/luceneBridge.js";
import { findJava, luceneDir } from "../../src/shamela/discover.js";
import { FIXTURE_ROOT } from "../helpers/paths.js";
import { acquireEngine, resetContext, selectBooks, type EngineHandle } from "../../src/context.js";
import { discoverIssue } from "../../src/pipeline/discoverIssue.js";
import { MADHHABS } from "../../src/classify/types.js";

/**
 * Scoping must happen inside Lucene, not after collection.
 *
 * This is a performance property with correctness-sized consequences. Shamela's
 * page index holds millions of documents; deciding which book a hit belongs to
 * by reading every hit's stored fields turned discover_issue from milliseconds
 * into minutes on a real library, which reads to a user as "the tool is broken".
 *
 * The guard is that the helper reports whether it pushed the scope down. If a
 * future change loses the book field, or names it wrongly, these fail rather
 * than quietly reverting to the slow path.
 */
describe("book scoping is pushed into Lucene", () => {
  const storeDir = join(FIXTURE_ROOT, "database", "store");
  let bridge: LuceneBridge;
  let handle: EngineHandle;

  beforeAll(async () => {
    resetContext();
    handle = await acquireEngine();
    const appDir = join(FIXTURE_ROOT, "app");
    bridge = new LuceneBridge({
      javaPath: findJava(appDir)!,
      luceneDir: luceneDir(appDir)!,
      storeDir,
    });
  }, 120_000);

  afterAll(async () => {
    handle?.release();
    await bridge?.close();
  });

  it("resolves a book field and filters with it", async () => {
    const res = await bridge.send<{ scope_pushed_down: boolean; hits: unknown[] }>("search", {
      terms: ["الزاويه"],
      mode: "any_terms",
      bookIds: ["1001", "2001"],
      limit: 5,
    });
    // If this is false the helper fell back to reading every hit to see which
    // book it came from — correct, but unusably slow on a real library.
    expect(res.scope_pushed_down).toBe(true);
  }, 60_000);

  it("returns only books that were asked for", async () => {
    const res = await bridge.send<{ hits: Array<{ book_id: string }> }>("search", {
      terms: ["الزاويه"],
      mode: "any_terms",
      bookIds: ["1001"],
      limit: 50,
    });
    expect(res.hits.length).toBeGreaterThan(0);
    for (const h of res.hits) expect(h.book_id).toBe("1001");
  }, 60_000);

  it("counts per book without walking the whole match set", async () => {
    const scoped = await bridge.send<{ counts: Array<{ book_id: string; hits: number }> }>("counts", {
      terms: ["الزاويه"],
      mode: "any_terms",
      bookIds: ["1001", "2001"],
    });
    const books = scoped.counts.map((c) => c.book_id).sort();
    expect(books).toEqual(["1001", "2001"]);
    // A bounded walk would report truncation; a per-book count never needs to.
    expect((scoped as Record<string, unknown>)["truncated"]).toBeUndefined();
  }, 60_000);

  it("discovers across the four madhhabs promptly", async () => {
    const started = Date.now();
    const d = await discoverIssue({
      query: "مسألة الزاوية الأولى في الترتيب المعياري",
      mode: "phrase",
      books: selectBooks({ madhhabs: [...MADHHABS] }),
      requested: MADHHABS,
      engine: handle.engine,
      limit: 25,
      pageSample: 5,
    });
    expect(d.totals.total_hits).toBeGreaterThan(0);
    // Generous for a small corpus, but it fails loudly if the per-hit walk
    // returns: that path took minutes on a real library.
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);
});
