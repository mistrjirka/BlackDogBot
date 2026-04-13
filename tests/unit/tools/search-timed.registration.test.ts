import { describe, it, expect } from "vitest";
import { searchTimedTool } from "../../../src/tools/search-timed.tool.js";
import { CRON_VALID_TOOL_NAMES } from "../../../src/shared/schemas/tool-schemas.js";

describe("searchTimedTool", () => {
  it("should be exported from tools index", async () => {
    const tools = await import("../../../src/tools/index.js");
    expect(tools.searchTimedTool).toBeDefined();
  });

  it("should be a valid cron tool name", () => {
    expect(CRON_VALID_TOOL_NAMES).toContain("search_timed");
  });

  it("should exist with execute function", () => {
    expect(searchTimedTool).toBeDefined();
    expect(typeof (searchTimedTool as any).execute).toBe("function");
  });

  it("should have inputSchema", () => {
    expect((searchTimedTool as any).inputSchema).toBeDefined();
  });

  it("should have description about search and timed tasks", () => {
    const description: string = (searchTimedTool as any).description.toLowerCase();
    expect(description).toContain("search");
    expect(description).toContain("timed");
  });
});
