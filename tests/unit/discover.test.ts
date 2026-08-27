import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { checkLibraryPath, locateLibrary } from "../../src/shamela/discover.js";
import { Fiqh4Error } from "../../src/util/errors.js";
import { FIXTURE_MANIFEST, FIXTURE_ROOT, REPO_ROOT, TEST_OUTPUT_DIR } from "../helpers/paths.js";

/**
 * The install-time question is never "is the library there?" — it is "*why*
 * is it not there?". These pin the per-path diagnosis: each way a configured
 * folder can be wrong must produce its own sentence, because "not found"
 * covering all of them is what made the old failure unactionable.
 */
describe("checkLibraryPath names the first thing wrong with a path", () => {
  it("accepts a real install root", () => {
    const c = checkLibraryPath(FIXTURE_ROOT);
    expect(c.problem_ar).toBeNull();
    expect(c.has_database).toBe(true);
    expect(c.has_app).toBe(true);
    expect(c.has_master_db).toBe(true);
    expect(c.master_db_path).toContain("master.db");
  });

  it("says so when the path does not exist at all", () => {
    const c = checkLibraryPath(join(REPO_ROOT, "no-such-shamela-anywhere"));
    expect(c.exists).toBe(false);
    expect(c.problem_ar).toContain("غير موجود");
  });

  it("says so when the path is a file, not a folder", () => {
    const c = checkLibraryPath(FIXTURE_MANIFEST);
    expect(c.exists).toBe(true);
    expect(c.is_directory).toBe(false);
    expect(c.problem_ar).toContain("ملف");
  });

  it("says a folder with neither database nor app is not a Shamela root", () => {
    // The repo itself: exists, is a directory, is definitely not an install.
    const c = checkLibraryPath(join(REPO_ROOT, "src"));
    expect(c.exists).toBe(true);
    expect(c.problem_ar).toContain("ليس هذا مجلد تثبيت الشاملة");
  });

  it("names the missing half when only one of database/app is present", () => {
    const root = join(TEST_OUTPUT_DIR, "half-install");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "database"), { recursive: true });
    const c = checkLibraryPath(root);
    expect(c.has_database).toBe(true);
    expect(c.has_app).toBe(false);
    expect(c.problem_ar).toContain("app");
  });

  it("names master.db when the folder structure is right but the catalogue is absent", () => {
    const root = join(TEST_OUTPUT_DIR, "no-master");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, "database"), { recursive: true });
    mkdirSync(join(root, "app"), { recursive: true });
    const c = checkLibraryPath(root);
    expect(c.has_database).toBe(true);
    expect(c.has_app).toBe(true);
    expect(c.has_master_db).toBe(false);
    expect(c.problem_ar).toContain("master.db");
  });
});

describe("locateLibrary failures carry the diagnosis", () => {
  it("an explicitly named bad path gets its own specific message, not a tried-list", () => {
    const bogus = join(REPO_ROOT, "no-such-shamela-anywhere");
    try {
      locateLibrary(bogus);
      throw new Error("expected locateLibrary to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(Fiqh4Error);
      const err = e as Fiqh4Error;
      expect(err.code).toBe("SHAMELA_DIR_MISSING");
      // The message must name the path *and* what is wrong with it.
      expect(err.messageAr).toContain(bogus);
      expect(err.messageAr).toContain("غير موجود");
      const checks = err.details["checks"] as Array<{ path: string; problem_ar: string }>;
      expect(checks).toHaveLength(1);
      expect(checks[0]!.path).toBe(bogus);
    }
  });

  it("a structurally wrong explicit path is diagnosed, not just rejected", () => {
    try {
      locateLibrary(join(REPO_ROOT, "src"));
      throw new Error("expected locateLibrary to throw");
    } catch (e) {
      const err = e as Fiqh4Error;
      expect(err.code).toBe("SHAMELA_DIR_MISSING");
      expect(err.messageAr).toContain("ليس هذا مجلد تثبيت الشاملة");
    }
  });
});
