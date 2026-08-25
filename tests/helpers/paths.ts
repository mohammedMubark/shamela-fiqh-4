import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const FIXTURE_ROOT = join(REPO_ROOT, "tests", "fixtures", "generated");
export const TEST_OUTPUT_DIR = join(REPO_ROOT, "tests", "fixtures", ".out");
export const FIXTURE_MANIFEST = join(FIXTURE_ROOT, "fixture-manifest.json");
