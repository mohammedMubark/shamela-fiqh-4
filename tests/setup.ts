import { FIXTURE_ROOT, TEST_OUTPUT_DIR } from "./helpers/paths.js";

/**
 * Points every worker at the synthetic library.
 *
 * The fixture is a faithful miniature install — it carries its own
 * app/lucene/2 jars and a bundled-JRE path — so nothing here needs to override
 * how Java or Lucene are found. Tests take the same route a real machine does.
 */
process.env["FIQH4_SHAMELA_DIR"] = FIXTURE_ROOT;
process.env["FIQH4_OUTPUT_DIR"] = TEST_OUTPUT_DIR;
process.env["FIQH4_LOG_LEVEL"] = "silent";
delete process.env["FIQH4_JAVA_PATH"];
