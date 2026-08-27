import { describe, expect, it } from "vitest";
import { nodeVersionProblem } from "../../src/util/preflight.js";

/**
 * The version gate in src/index.ts. It exists because on Node < 22.5 the
 * first import of node:sqlite dies with ERR_UNKNOWN_BUILTIN_MODULE — a message
 * that names neither Node nor the fix — and Claude Desktop surfaces only
 * "server disconnected". The gate turns that into one bilingual sentence.
 */
describe("nodeVersionProblem", () => {
  it("rejects Nodes that predate node:sqlite", () => {
    for (const v of ["18.19.0", "20.11.1", "21.7.3", "22.4.1"]) {
      const p = nodeVersionProblem(v);
      expect(p, v).not.toBeNull();
      // Both halves must name the running version and the required one.
      expect(p!.ar).toContain(v);
      expect(p!.ar).toContain("22.5.0");
      expect(p!.en).toContain(v);
      expect(p!.en).toContain("22.5.0");
    }
  });

  it("accepts 22.5.0 and everything after it", () => {
    for (const v of ["22.5.0", "22.12.0", "23.0.0", "24.1.0"]) {
      expect(nodeVersionProblem(v), v).toBeNull();
    }
  });

  it("treats an unparsable version as too old rather than letting it through", () => {
    expect(nodeVersionProblem("weird")).not.toBeNull();
  });
});
