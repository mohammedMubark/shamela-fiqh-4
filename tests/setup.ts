import { FIXTURE_ROOT, TEST_INDEX_DIR, TEST_OUTPUT_DIR } from "./helpers/paths.js";

/**
 * Points every worker at the synthetic library. Set before any module reads
 * them, since the source resolves these lazily at call time.
 */
process.env["FIQH4_SHAMELA_DIR"] = FIXTURE_ROOT;
process.env["FIQH4_INDEX_DIR"] = TEST_INDEX_DIR;
process.env["FIQH4_OUTPUT_DIR"] = TEST_OUTPUT_DIR;
process.env["FIQH4_LOG_LEVEL"] = "silent";
// The Lucene backend is opt-in; unit and integration tests must exercise the
// default engine unless a test explicitly opts in.
delete process.env["FIQH4_LUCENE_JAR"];
