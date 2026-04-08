import { describe, it, expect } from "vitest";
import { editIntervalTool } from "../../../src/tools/edit-interval.tool.js";

describe("editIntervalTool", () => {
  it("should exist with execute function", () => {
    expect(editIntervalTool).toBeDefined();
    expect(typeof (editIntervalTool as any).execute).toBe("function");
  });

  it("should have inputSchema", () => {
    expect((editIntervalTool as any).inputSchema).toBeDefined();
  });

  it("should have description about editing interval tasks", () => {
    expect((editIntervalTool as any).description).toContain("interval");
  });
});
