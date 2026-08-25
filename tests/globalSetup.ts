import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_MANIFEST, REPO_ROOT, TEST_OUTPUT_DIR } from "./helpers/paths.js";

/**
 * Builds the Java helper and the synthetic corpus once for the whole run.
 *
 * Both are needed now: Shamela 4 keeps book text in Lucene, so the fixtures
 * include a real Lucene index and the tests read it through the same helper a
 * user's install would. There is no derived index to build — the extension
 * queries Shamela's own.
 */
export async function setup(): Promise<void> {
  rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });

  // The fixture generator needs the helper's test tooling to write its index.
  if (!existsSync(join(REPO_ROOT, "java", "test-classes"))) {
    execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "build-java.mjs")], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }

  if (!existsSync(FIXTURE_MANIFEST)) {
    execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "make-fixtures.mjs")], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
  }
}

export async function teardown(): Promise<void> {
  rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
}
