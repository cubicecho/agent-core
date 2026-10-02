/**
 * The contract between whatever holds the tools and the loop that offers them to a model.
 *
 * This lives here rather than with the MCP pool because it is what `tool-loading.ts` reads, and
 * nothing about it is MCP-specific: it is a list of names and one-line descriptions, grouped by
 * where they came from. A caller with tools from somewhere else entirely satisfies it by
 * building the array.
 */

/** One server's tools, without their JSON schemas — the cheap half of a tool definition. */
export interface CatalogServer {
  id: string;
  label: string;
  tools: { name: string; description: string }[];
}
