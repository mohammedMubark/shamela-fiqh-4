import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHealth } from "../tools/health.js";
import { registerGuide } from "../tools/guide.js";
import { registerListBooks } from "../tools/listBooks.js";
import { registerSearch } from "../tools/search.js";
import { registerDiscoverIssue } from "../tools/discoverIssue.js";
import { registerFetchPassages } from "../tools/fetchPassages.js";
import { registerCompareIssue } from "../tools/compareIssue.js";
import { registerExportResults } from "../tools/exportResults.js";
import { registerCitation } from "../tools/citation.js";

/**
 * The complete tool surface. This list is the single source of truth that
 * scripts/check-manifest-parity.mjs asserts manifest.json against, so the
 * two can never drift apart unnoticed.
 */
export const TOOL_NAMES = [
  "fiqh4_health",
  "fiqh4_guide",
  "fiqh4_list_books",
  "fiqh4_search",
  "fiqh4_discover_issue",
  "fiqh4_fetch_passages",
  "fiqh4_compare_issue",
  "fiqh4_export_results",
  "fiqh4_citation",
] as const;

export function registerAllTools(server: McpServer): void {
  registerHealth(server);
  registerGuide(server);
  registerListBooks(server);
  registerSearch(server);
  registerDiscoverIssue(server);
  registerFetchPassages(server);
  registerCompareIssue(server);
  registerExportResults(server);
  registerCitation(server);
}
