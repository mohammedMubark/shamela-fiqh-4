import { afterAll } from "vitest";
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

/**
 * The helper stays alive between calls inside one test file, exactly as it does
 * for a user's session — that is what the lifecycle and round-trip tests check.
 * It must not outlive the file, though: vitest forks a worker per file, and a
 * live child process with open pipes would keep that worker from exiting.
 */
process.env["FIQH4_ENGINE_IDLE_MS"] = "30000";

const { resetContext } = await import("../src/context.js");
afterAll(() => resetContext());
