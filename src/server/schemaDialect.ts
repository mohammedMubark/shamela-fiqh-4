import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * Strip the JSON Schema dialect label from `tools/list`.
 *
 * The SDK builds tool schemas from Zod with `zod-to-json-schema`, which stamps
 * every one with `"$schema": "http://json-schema.org/draft-07/schema#"`. Some
 * MCP clients validate `structuredContent` with a 2020-12-only validator and
 * reject the tool outright:
 *
 *     Tool has an invalid outputSchema: unsupported dialect `draft-07`
 *
 * The tool is then unusable before any request reaches this server — which hit
 * `fiqh4_health` first, the one tool whose job is to explain failures.
 *
 * The label is removed rather than rewritten to 2020-12. What the SDK emits for
 * these tools — objects, properties, enums, `items` as a single schema, numeric
 * bounds — is identical under both dialects, so declaring 2020-12 would be
 * accurate today and a lie the moment a schema grows a tuple or a `$ref`.
 * Omitting `$schema` says what is true: the schema is dialect-agnostic, and a
 * validator should use its own default. `$schema` is optional in the MCP
 * schema, so nothing is owed a value here.
 *
 * This wraps the transport rather than the request handler because `send` is
 * part of the public `Transport` interface, while the handler the SDK installs
 * for `tools/list` is private and would have to be rebuilt wholesale.
 */
export function stripSchemaDialect<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = (message: unknown, options?: unknown) =>
    (send as (m: unknown, o?: unknown) => Promise<void>)(sanitizeToolList(message), options);
  return transport;
}

/** Remove `$schema` from every tool schema in a `tools/list` result. */
export function sanitizeToolList<T>(message: T): T {
  const tools = (message as { result?: { tools?: unknown } } | null)?.result?.tools;
  if (!Array.isArray(tools)) return message;
  for (const tool of tools) {
    dropDialect((tool as { inputSchema?: unknown }).inputSchema);
    dropDialect((tool as { outputSchema?: unknown }).outputSchema);
  }
  return message;
}

function dropDialect(schema: unknown): void {
  if (schema && typeof schema === "object" && "$schema" in schema) {
    delete (schema as Record<string, unknown>)["$schema"];
  }
}
