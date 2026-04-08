import { describe, it, expect } from "vitest";
import { runTimedTool } from "../../../src/tools/run-timed.tool.js";

describe("runTimedTool", () => {
  it("should exist with correct structure", () => {
    expect(runTimedTool).toBeDefined();
    expect(typeof runTimedTool).toBe("object");
    expect(runTimedTool.description).toContain("run");
    expect(runTimedTool.description).toContain("timed");
    expect(typeof runTimedTool.execute).toBe("function");
  });
});
