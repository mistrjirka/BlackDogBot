import { describe, it, expect } from "vitest";
import { editOnceTool } from "../../../src/tools/edit-once.tool.js";

describe("editOnceTool", () => {
  it("should exist with execute function", () => {
    expect(editOnceTool).toBeDefined();
    expect(typeof (editOnceTool as any).execute).toBe("function");
  });

  it("should have inputSchema", () => {
    expect((editOnceTool as any).inputSchema).toBeDefined();
  });

  it("should have description about editing one-time tasks", () => {
    expect((editOnceTool as any).description).toContain("one-time");
  });
});
