import { describe, it, expect } from "vitest";
import { listTimedTool } from "../../../src/tools/list-timed.tool.js";

describe("listTimedTool", () => {
  it("should exist with correct structure", () => {
    expect(listTimedTool).toBeDefined();
    expect(typeof listTimedTool).toBe("object");
    expect(listTimedTool.description.toLowerCase()).toContain("list");
    expect(listTimedTool.description).toContain("timed");
    expect(typeof listTimedTool.execute).toBe("function");
  });
});
