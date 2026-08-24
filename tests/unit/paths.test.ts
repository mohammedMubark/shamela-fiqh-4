import { describe, expect, it, beforeAll } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertSafeSegment, isInside, resolveSafeOutputDir } from "../../src/util/paths.js";
import { Fiqh4Error } from "../../src/util/errors.js";

let base: string;
let outputRoot: string;
let shamelaDir: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "fiqh4-paths-"));
  outputRoot = join(base, "exports");
  shamelaDir = join(base, "shamela");
  mkdirSync(outputRoot, { recursive: true });
  mkdirSync(join(shamelaDir, "Books"), { recursive: true });
  writeFileSync(join(shamelaDir, "master.db"), "");
});

describe("isInside", () => {
  it("treats a directory as inside itself", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
  });
  it("does not confuse sibling prefixes", () => {
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
  });
});

describe("resolveSafeOutputDir", () => {
  it("defaults to the output root", () => {
    expect(resolveSafeOutputDir({ outputRoot, shamelaDir })).toBe(resolve(outputRoot));
  });

  it("resolves a relative path inside the output root", () => {
    expect(resolveSafeOutputDir({ requested: "job-1", outputRoot, shamelaDir })).toBe(
      join(resolve(outputRoot), "job-1"),
    );
  });

  it("refuses traversal out of the output root", () => {
    expect(() =>
      resolveSafeOutputDir({ requested: "../../etc", outputRoot, shamelaDir }),
    ).toThrow(Fiqh4Error);
  });

  it("refuses an absolute path outside the output root", () => {
    try {
      resolveSafeOutputDir({ requested: "/tmp/anywhere", outputRoot, shamelaDir });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Fiqh4Error).code).toBe("UNSAFE_OUTPUT_PATH");
    }
  });

  it("refuses to write into the Shamela installation", () => {
    try {
      resolveSafeOutputDir({ requested: shamelaDir, outputRoot: base, shamelaDir });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Fiqh4Error).code).toBe("WRITE_INTO_SHAMELA_DIR");
      expect((e as Fiqh4Error).messageAr).toContain("مُنع الكتابة داخل مجلد المكتبة الشاملة");
    }
  });

  it("refuses to write beneath the Shamela installation", () => {
    try {
      resolveSafeOutputDir({ requested: join(shamelaDir, "Books", "out"), outputRoot: base, shamelaDir });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Fiqh4Error).code).toBe("WRITE_INTO_SHAMELA_DIR");
    }
  });

  it("is not fooled by a symlink pointing into the Shamela folder", () => {
    // A symlink inside the allowed root whose target is the library would pass a
    // naive string prefix check; realpath resolution is what catches it.
    const link = join(outputRoot, "sneaky");
    try {
      symlinkSync(shamelaDir, link, "dir");
    } catch {
      return; // symlinks unavailable on this platform
    }
    try {
      resolveSafeOutputDir({ requested: link, outputRoot, shamelaDir });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(Fiqh4Error);
      expect((e as Fiqh4Error).code).toBe("WRITE_INTO_SHAMELA_DIR");
    }
  });
});

describe("assertSafeSegment", () => {
  it("accepts an ordinary job id", () => {
    expect(assertSafeSegment("khiyar-al-majlis")).toBe("khiyar-al-majlis");
  });
  it("rejects separators, traversal and reserved characters", () => {
    for (const bad of ["a/b", "a\\b", "..", ".", "", "a:b", "a*b", "a\0b"]) {
      expect(() => assertSafeSegment(bad)).toThrow(Fiqh4Error);
    }
  });
});
