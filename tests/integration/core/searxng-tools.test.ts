import { describe, expect, it } from "vitest";
import { getAllowedToolNames, isToolAllowed } from "../../../src/helpers/tool-registry.js";
import { CRON_VALID_TOOL_NAMES } from "../../../src/shared/schemas/tool-schemas.js";
import { CRON_TOOL_DESCRIPTIONS } from "../../../src/shared/constants/cron-descriptions.js";
import { resolveLegacyCronToolName } from "../../../src/utils/cron-tool-validation.js";
import { createAgentBaseToolSet } from "../../../src/agent/tool-assembly.js";
import { FileReadTracker } from "../../../src/tools/index.js";

describe("SearXNG is discovered via MCP, not a hardcoded agent tool", () => {
  it("does not expose the legacy built-in SearXNG tool", () => {
    const core = getAllowedToolNames("full");
    expect(core).not.toContain("searxng");
    const base = createAgentBaseToolSet(async () => null, new FileReadTracker());
    expect(base).not.toHaveProperty("searxng");
  });

  it("allows search MCP tools for read-only chats", () => {
    expect(isToolAllowed("mcp.searxng.searxng_web_search", "read_only")).toBe(true);
    expect(isToolAllowed("mcp.searxng.searxng_instance_info", "read_only")).toBe(true);
    expect(isToolAllowed("mcp.searxng.web_url_read", "read_only")).toBe(true);
  });

  it("preserves scheduled search tasks while accepting the new MCP name", () => {
    expect(resolveLegacyCronToolName("searxng")).toBe("mcp.searxng.searxng_web_search");
    expect(resolveLegacyCronToolName("mcp.crawl4ai.md")).toBe("mcp.crawl4ai.md");
    expect(CRON_VALID_TOOL_NAMES).toContain("searxng");
    expect(CRON_VALID_TOOL_NAMES).toContain("mcp.searxng.searxng_web_search");
    expect(CRON_TOOL_DESCRIPTIONS.searxng).toContain("Legacy");
  });
});
