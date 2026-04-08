import { describe, it, expect } from "vitest";
import { addOnceTool } from "../../../src/tools/add-once.tool.js";

describe("addOnceTool", () => {
  it("should exist with execute function", () => {
    expect(addOnceTool).toBeDefined();
    expect(typeof (addOnceTool as any).execute).toBe("function");
  });

  it("should have inputSchema", () => {
    expect((addOnceTool as any).inputSchema).toBeDefined();
  });

  it("should have description about one-time tasks", () => {
    expect((addOnceTool as any).description).toContain("one-time");
  });
});
