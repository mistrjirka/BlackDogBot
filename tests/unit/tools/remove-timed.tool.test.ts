import { describe, it, expect } from "vitest";
import { removeTimedTool } from "../../../src/tools/remove-timed.tool.js";

describe("removeTimedTool", () => {
  it("should exist with correct structure", () => {
    expect(removeTimedTool).toBeDefined();
    expect(typeof removeTimedTool).toBe("object");
    expect(removeTimedTool.description.toLowerCase()).toContain("remove");
    expect(removeTimedTool.description).toContain("timed");
    expect(typeof removeTimedTool.execute).toBe("function");
  });
});
