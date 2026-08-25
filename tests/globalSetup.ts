import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_ROOT, REPO_ROOT, TEST_INDEX_DIR, TEST_OUTPUT_DIR } from "./helpers/paths.js";

/**
 * Builds the synthetic corpus and its Lucene indexes once for the whole run.
 *
 * Tests run against generated fixtures rather than any real library, so the
 * suite is self-contained: CI has no Shamela installation and must still
 * exercise every code path end to end.
 */
export async function setup(): Promise<void> {
  rmSync(TEST_INDEX_DIR, { recursive: true, force: true });
  rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
  rmSync(FIXTURE_ROOT, { recursive: true, force: true });

  execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "build-java.mjs")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "make-fixtures.mjs")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
}

export async function teardown(): Promise<void> {
  rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
}
