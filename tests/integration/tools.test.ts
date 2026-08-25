import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAllTools, TOOL_NAMES } from "../../src/server/registerTools.js";
import { FIXTURE_MANIFEST } from "../helpers/paths.js";
import { resetContext } from "../../src/context.js";

/**
 * Drives the real MCP surface through a client.
 *
 * This is where output schemas get exercised: the SDK validates every
 * structuredContent payload against the tool's declared outputSchema, so a tool
 * that emits a shape it did not promise fails here rather than in the user's
 * Claude Desktop.
 */

const fixtures = JSON.parse(readFileSync(FIXTURE_MANIFEST, "utf8")) as {
  planted_phrases: Record<string, string>;
  books: Array<{ book_id: string; downloaded: boolean; planted: string[]; planted_pages: Record<string, number[]> }>;
};
const ALPHA = fixtures.planted_phrases["alpha"]!;
const withAlpha = fixtures.books.find((b) => b.downloaded && b.planted.includes("alpha"))!;

let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  };
  return res;
}

beforeAll(async () => {
  resetContext();
  const server = new McpServer({ name: "shamela-fiqh-4", version: "0.1.0" });
  registerAllTools(server);
  client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client?.close();
});

describe("tool surface", () => {
  it("registers exactly the nine specified tools, all fiqh4_-prefixed", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
    expect(names).toHaveLength(9);
    for (const n of names) expect(n.startsWith("fiqh4_")).toBe(true);
  });

  it("gives every tool an Arabic description and an output schema", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description ?? "").toMatch(/[؀-ۿ]/);
      expect(t.outputSchema).toBeDefined();
    }
  });

  it("marks the read-only tools as read-only and the exporter as writing", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const n of TOOL_NAMES.filter((x) => x !== "fiqh4_export_results")) {
      expect(byName.get(n)?.annotations?.readOnlyHint).toBe(true);
    }
    expect(byName.get("fiqh4_export_results")?.annotations?.readOnlyHint).toBe(false);
  });
});

describe("fiqh4_health", () => {
  it("reports the library, schema probe, classification and index state", async () => {
    const r = await call("fiqh4_health");
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as Record<string, Record<string, unknown>>;
    expect(s["library"]!["access_mode"]).toBe("read-only");
    expect(s["schema"]!["master"]).toBeTruthy();
    expect(Array.isArray(s["warnings_ar"])).toBe(true);
  });

  it("reports Shamela's own index as the search source, not one of ours", async () => {
    const r = await call("fiqh4_health");
    const s = r.structuredContent as Record<string, Record<string, unknown>>;
    // The extension builds no index: it queries the one Shamela already has.
    expect(s["index"]!["source"]).toBe("shamela");
    expect(s["index"]!["page_index"]).toBe(true);
    expect(s["index"]!["readable"]).toBe(true);
    expect(Number(s["index"]!["page_documents"])).toBeGreaterThan(0);
    expect(s["engines"]!["active"]).toBe("lucene");
  });

  it("names the Java and Lucene it borrows from the install", async () => {
    const r = await call("fiqh4_health");
    const engines = (r.structuredContent as Record<string, Record<string, unknown>>)["engines"]!;
    // Both come from the user's Shamela; this extension ships neither.
    expect(String(engines["java_path"])).toContain("jre");
    expect(String(engines["lucene_dir"])).toContain("lucene");
  });

  it("surfaces unmapped categories so the map can be audited", async () => {
    const r = await call("fiqh4_health");
    const cls = (r.structuredContent as Record<string, Record<string, unknown>>)["classification"]!;
    expect((cls["unmapped_categories"] as unknown[]).length).toBeGreaterThan(0);
    expect(cls["needs_review"]).toBeGreaterThan(0);
  });
});

describe("fiqh4_guide", () => {
  it("states the limits, including that it does not issue rulings", async () => {
    const r = await call("fiqh4_guide");
    const limits = (r.structuredContent as Record<string, string[]>)["limits_ar"]!;
    expect(limits.join(" ")).toContain("لا تُصدر فتوى");
    expect(limits.join(" ")).toContain("لا يعني أن المذهب لا قول له");
  });

  it("returns only the section asked for", async () => {
    // The topic argument was declared and then ignored, so every call returned
    // the whole manual — thousands of tokens for the one section wanted.
    const full = await call("fiqh4_guide");
    const limits = await call("fiqh4_guide", { topic: "limits" });

    const fullKeys = Object.keys(full.structuredContent ?? {});
    const limitKeys = Object.keys(limits.structuredContent ?? {});
    expect(limitKeys.length).toBeLessThan(fullKeys.length);
    expect(limits.structuredContent?.["limits_ar"]).toBeTruthy();
    expect(limits.structuredContent?.["examples"]).toBeUndefined();
    expect(limits.structuredContent?.["topic"]).toBe("limits");

    // Smaller on the wire, not merely differently shaped.
    expect(JSON.stringify(limits.structuredContent).length).toBeLessThan(
      JSON.stringify(full.structuredContent).length,
    );
  });
});

describe("fiqh4_list_books", () => {
  it("returns classification provenance with every book", async () => {
    const r = await call("fiqh4_list_books", { limit: 5 });
    const books = (r.structuredContent as Record<string, unknown[]>)["books"]!;
    expect(books.length).toBe(5);
    for (const b of books as Array<Record<string, unknown>>) {
      expect(b["book_id"]).toBeTruthy();
      expect(b["classification_source"]).toBeTruthy();
      expect(b["verification_status"]).toBeTruthy();
      expect(Array.isArray(b["ambiguity_reasons"])).toBe(true);
    }
  });

  it("pages through the whole catalogue without repeating a book", async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let rounds = 0;
    do {
      const r = await call("fiqh4_list_books", { limit: 4, ...(cursor ? { cursor } : {}) });
      const s = r.structuredContent as Record<string, any>;
      for (const b of s["books"]) {
        expect(seen.has(b.book_id)).toBe(false);
        seen.add(b.book_id);
      }
      cursor = s["batch"].next_cursor ?? undefined;
      rounds++;
    } while (cursor && rounds < 50);
    expect(rounds).toBeGreaterThan(1);
    expect(seen.size).toBeGreaterThan(10);
  });

  it("filters to books needing review", async () => {
    const r = await call("fiqh4_list_books", { verification_status: ["needs_review"], limit: 50 });
    const books = (r.structuredContent as Record<string, any>)["books"];
    expect(books.length).toBeGreaterThan(0);
    for (const b of books) expect(b.verification_status).toBe("needs_review");
  });
});

describe("fiqh4_search", () => {
  it("returns attributed passages with the batch envelope", async () => {
    const r = await call("fiqh4_search", { query: ALPHA, match_mode: "phrase", limit: 3 });
    const s = r.structuredContent as Record<string, any>;
    expect(s["batch"].total_hits).toBeGreaterThan(3);
    expect(s["batch"].returned).toBe(3);
    expect(s["batch"].truncated).toBe(true);
    expect(s["batch"].truncation_reason).toBe("max_results_per_response");
    // Stated once for the whole response rather than repeated in every passage.
    expect(s["notes"].content_trust).toBe("untrusted_source_text");
    expect(s["notes"].query).toBe(ALPHA);
    expect(s["passages"][0].content_trust).toBeUndefined();
  });

  it("reports an invalid query as a typed error, not a crash", async () => {
    const r = await call("fiqh4_search", { query: "؟!،", match_mode: "all_terms" });
    expect(r.isError).toBe(true);
    const s = r.structuredContent as Record<string, any>;
    expect(s["error"].code).toBe("INVALID_QUERY");
    expect(s["error"].message_ar).toMatch(/[؀-ۿ]/);
  });

  it("rejects a stale cursor with an Arabic explanation", async () => {
    const first = await call("fiqh4_search", { query: ALPHA, match_mode: "phrase", limit: 2 });
    const cursor = (first.structuredContent as Record<string, any>)["batch"].next_cursor;
    const r = await call("fiqh4_search", {
      query: fixtures.planted_phrases["beta"]!,
      match_mode: "phrase",
      limit: 2,
      cursor,
    });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as Record<string, any>)["error"].code).toBe("CURSOR_STALE");
  });
});

describe("fiqh4_discover_issue then fiqh4_fetch_passages", () => {
  it("maps the terrain, then reads the pages it pointed at", async () => {
    const d = await call("fiqh4_discover_issue", {
      query: ALPHA,
      match_mode: "phrase",
      limit: 25,
      page_sample: 3,
    });
    const ds = d.structuredContent as Record<string, any>;
    expect(ds["totals"].books_with_hits).toBeGreaterThan(1);
    expect(ds["totals"].by_madhhab.length).toBeGreaterThan(1);
    expect(ds["coverage"].books_not_downloaded.length).toBeGreaterThan(0);

    const first = ds["books"][0];
    const f = await call("fiqh4_fetch_passages", {
      query: ALPHA,
      match_mode: "phrase",
      requests: [{ book_id: first.book_id, page_ids: first.page_ids }],
      neighbors: 1,
    });
    const fs = f.structuredContent as Record<string, any>;
    expect(fs["passages"].length).toBeGreaterThan(0);
    for (const p of fs["passages"]) {
      expect(p.book_id).toBe(first.book_id);
      expect(typeof p.text_original).toBe("string");
    }
  });
});

describe("fiqh4_compare_issue", () => {
  it("groups by madhhab and names the schools with no textual match", async () => {
    const r = await call("fiqh4_compare_issue", {
      query: ALPHA,
      match_mode: "phrase",
      per_madhhab_limit: 3,
    });
    const s = r.structuredContent as Record<string, any>;
    expect(s["groups"].length).toBe(4);
    expect(s["disclaimer_ar"]).toContain("لا تُصدر حكمًا فقهيًا");
    for (const g of s["groups"]) {
      expect(g.coverage_note_ar.length).toBeGreaterThan(0);
      if (g.passages_count === 0) expect(g.coverage_note_ar).toContain("ليس نفيًا");
    }
  });

  it("exposes no ruling, ranking or consensus key anywhere in the real output", async () => {
    // Structural, not stylistic: the response shape has nowhere to put a
    // verdict, so the tool cannot smuggle one out even by accident.
    const r = await call("fiqh4_compare_issue", {
      query: ALPHA,
      match_mode: "phrase",
      per_madhhab_limit: 2,
    });

    const forbidden = ["ruling", "verdict", "fatwa", "consensus", "ijma", "preferred", "strongest", "rajih", "tarjih"];
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) {
          keys.add(k.toLowerCase());
          walk(child);
        }
      }
    };
    walk(r.structuredContent);

    expect(keys.size).toBeGreaterThan(5); // we actually walked a real payload
    for (const key of keys) {
      for (const f of forbidden) expect(key).not.toContain(f);
    }
  });
});

describe("fiqh4_citation", () => {
  it("builds a citation and declares the numbering authority", async () => {
    const page = withAlpha.planted_pages["alpha"]![0]!;
    const r = await call("fiqh4_citation", { book_id: withAlpha.book_id, page_id: page });
    const s = r.structuredContent as Record<string, any>;
    expect(s["citation"].book_id).toBe(withAlpha.book_id);
    expect(s["citation"].numbering_authority).toBe("shamela");
    expect(s["citation"].edition).toBeNull();
    expect(s["formatted_ar"]).toContain("المكتبة الشاملة");
    expect(s["caveats_ar"].length).toBeGreaterThan(0);
  });

  it("errors clearly for a book that is not downloaded", async () => {
    const missing = fixtures.books.find((b) => !b.downloaded)!;
    const r = await call("fiqh4_citation", { book_id: missing.book_id, page_id: 1 });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as Record<string, any>)["error"].code).toBe("BOOK_NOT_DOWNLOADED");
  });

  it("errors clearly for an unknown book", async () => {
    const r = await call("fiqh4_citation", { book_id: "nope", page_id: 1 });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as Record<string, any>)["error"].code).toBe("BOOK_NOT_FOUND");
  });
});

describe("fiqh4_export_results", () => {
  it("writes an export and refuses a path outside the output root", async () => {
    const good = await call("fiqh4_export_results", {
      query: ALPHA,
      match_mode: "phrase",
      job_id: "tool-export",
      include_full_text: false,
    });
    const s = good.structuredContent as Record<string, any>;
    expect(s["total_hits"]).toBeGreaterThan(0);
    expect(s["checksum"]).toMatch(/^[0-9a-f]{64}$/);
    expect(s["files"].length).toBe(3);

    const bad = await call("fiqh4_export_results", {
      query: ALPHA,
      match_mode: "phrase",
      job_id: "escape",
      output_dir: "/etc",
    });
    expect(bad.isError).toBe(true);
    expect((bad.structuredContent as Record<string, any>)["error"].code).toBe("UNSAFE_OUTPUT_PATH");
  });
});
