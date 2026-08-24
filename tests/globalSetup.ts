import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_MANIFEST, FIXTURE_ROOT, REPO_ROOT, TEST_INDEX_DIR, TEST_OUTPUT_DIR } from "./helpers/paths.js";

/**
 * Builds the synthetic corpus and its index once for the whole run.
 *
 * Tests run against generated fixtures rather than any real library, so the
 * suite is self-contained: CI has no Shamela installation and must still
 * exercise every code path end to end.
 */
export async function setup(): Promise<void> {
  rmSync(TEST_INDEX_DIR, { recursive: true, force: true });
  rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });

  if (!existsSync(FIXTURE_MANIFEST)) {
    execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "make-fixtures.mjs")], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }

  // The index builder runs from dist/, so the build must be current.
  if (!existsSync(join(REPO_ROOT, "dist", "index.js"))) {
    execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], { cwd: REPO_ROOT, stdio: "inherit" });
  }

  execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "build-index.mjs")], {
    cwd: REPO_ROOT,
    stdio: "pipe",
    env: {
      ...process.env,
      FIQH4_SHAMELA_DIR: FIXTURE_ROOT,
      FIQH4_INDEX_DIR: TEST_INDEX_DIR,
    },
  });
}

export async function teardown(): Promise<void> {
  rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
}
