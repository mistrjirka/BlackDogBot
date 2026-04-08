import { describe, it, expect } from "vitest";
import { getTimedTool } from "../../../src/tools/get-timed.tool.js";

describe("getTimedTool", () => {
  it("should exist with correct structure", () => {
    expect(getTimedTool).toBeDefined();
    expect(typeof getTimedTool).toBe("object");
    expect(getTimedTool.description.toLowerCase()).toContain("get");
    expect(getTimedTool.description).toContain("timed");
    expect(typeof getTimedTool.execute).toBe("function");
  });
});
