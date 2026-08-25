import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeToolList, stripSchemaDialect } from "../../src/server/schemaDialect.js";
import { REPO_ROOT } from "../helpers/paths.js";

describe("sanitizeToolList", () => {
  it("removes the draft-07 label a 2020-12-only client refuses", () => {
    const message = {
      result: {
        tools: [
          {
            name: "fiqh4_health",
            inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
            outputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
          },
        ],
      },
    };
    sanitizeToolList(message);
    expect(message.result.tools[0]!.inputSchema).not.toHaveProperty("$schema");
    expect(message.result.tools[0]!.outputSchema).not.toHaveProperty("$schema");
    // Everything else survives untouched.
    expect(message.result.tools[0]!.inputSchema.type).toBe("object");
  });

  it("leaves a tool without an output schema alone", () => {
    const message = { result: { tools: [{ name: "fiqh4_guide", inputSchema: { type: "object" } }] } };
    expect(() => sanitizeToolList(message)).not.toThrow();
  });

  it("passes through messages that are not tool listings", () => {
    const message = { result: { content: [{ type: "text", text: "x" }] } };
    expect(sanitizeToolList(message)).toBe(message);
    expect(sanitizeToolList(null)).toBeNull();
  });
});

describe("stripSchemaDialect", () => {
  it("sanitises what the transport actually sends", async () => {
    const sent: unknown[] = [];
    const transport = {
      send: async (m: unknown) => {
        sent.push(m);
      },
      start: async () => {},
      close: async () => {},
    };
    stripSchemaDialect(transport as never);
    await (transport as { send: (m: unknown) => Promise<void> }).send({
      result: { tools: [{ name: "t", outputSchema: { $schema: "draft-07", type: "object" } }] },
    });
    expect((sent[0] as never as { result: { tools: { outputSchema: object }[] } }).result.tools[0]!.outputSchema)
      .not.toHaveProperty("$schema");
  });
});

/**
 * The manifest half of the same class of bug the config module guards against.
 * scripts/check-manifest-parity.mjs asserts this too, but that runs in a
 * separate CI job; a field losing its default should also fail `npm test`.
 */
describe("manifest user_config", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "manifest.json"), "utf8")) as {
    user_config: Record<string, { required?: boolean; default?: unknown }>;
    server: { mcp_config: { env: Record<string, string> } };
  };

  it("gives every optional field a default, so its placeholder is always substituted", () => {
    const missing = Object.entries(manifest.user_config)
      .filter(([, f]) => f.required !== true && f.default === undefined)
      .map(([k]) => k);
    expect(missing).toEqual([]);
  });

  it("wires every declared field to an environment variable", () => {
    const wired = new Set(Object.values(manifest.server.mcp_config.env));
    for (const key of Object.keys(manifest.user_config)) {
      expect(wired.has(`\${user_config.${key}}`)).toBe(true);
    }
  });
});
