import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { LuceneBridge } from "../../src/search/luceneBridge.js";
import { FIXTURE_ROOT, REPO_ROOT } from "../helpers/paths.js";
import { Fiqh4Error } from "../../src/util/errors.js";

/**
 * How the extension fails when Java will not start.
 *
 * This matters more than it sounds. Book text lives in Shamela's Lucene index,
 * so every failure to launch the helper takes six of the nine tools with it —
 * and a user seeing only "a Java environment issue" has nothing to act on. Each
 * case below must fail fast and name the cause.
 *
 * The first case is also a regression guard: with no 'error' listener on the
 * child process, a missing binary raises an unhandled event and every pending
 * request hangs until its timeout instead of failing.
 */
describe("Java launch failures are reported, not hidden", () => {
  const storeDir = join(FIXTURE_ROOT, "database", "store");
  const luceneDir = join(FIXTURE_ROOT, "app", "lucene", "2");

  it("names the java path when the binary does not exist", async () => {
    const bridge = new LuceneBridge(
      { javaPath: join(REPO_ROOT, "no-such-java"), luceneDir, storeDir },
      15_000,
    );
    try {
      await expect(bridge.send("health")).rejects.toThrow(Fiqh4Error);
      await bridge.send("health").catch((e: Fiqh4Error) => {
        expect(e.code).toBe("ENGINE_UNAVAILABLE");
        expect(e.messageAr).toContain("no-such-java");
        expect(e.details["java_path"]).toContain("no-such-java");
      });
    } finally {
      await bridge.close();
    }
  }, 60_000);

  it("passes Java's own error through when the helper cannot start", async () => {
    // A real JVM that cannot find our main class: the JVM's message is the
    // only thing that explains why, so it must reach the caller.
    const bridge = new LuceneBridge({ javaPath: "java", luceneDir, storeDir }, 30_000);
    const previous = process.env["FIQH4_HELPER_CLASSES"];
    process.env["FIQH4_HELPER_CLASSES"] = join(REPO_ROOT, "dist");
    try {
      await bridge.send("health");
      throw new Error("expected the helper to fail");
    } catch (e) {
      expect(e).toBeInstanceOf(Fiqh4Error);
      const err = e as Fiqh4Error;
      expect(err.code).toBe("ENGINE_UNAVAILABLE");
      // Java says "Could not find or load main class"; that text is the point.
      expect(String(err.details["stderr"] ?? "")).toContain("main class");
    } finally {
      if (previous === undefined) delete process.env["FIQH4_HELPER_CLASSES"];
      else process.env["FIQH4_HELPER_CLASSES"] = previous;
      await bridge.close();
    }
  }, 60_000);
});
