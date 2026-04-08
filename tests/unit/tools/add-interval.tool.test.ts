import { describe, it, expect } from "vitest";
import { addIntervalTool } from "../../../src/tools/add-interval.tool.js";

describe("addIntervalTool", () => {
  it("should exist with execute function", () => {
    expect(addIntervalTool).toBeDefined();
    expect(typeof (addIntervalTool as any).execute).toBe("function");
  });

  it("should have inputSchema", () => {
    expect((addIntervalTool as any).inputSchema).toBeDefined();
  });

  it("should have description about recurring tasks", () => {
    expect((addIntervalTool as any).description.toLowerCase()).toContain("recurring");
  });
});
