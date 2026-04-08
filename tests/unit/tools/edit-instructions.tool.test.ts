import { describe, it, expect } from "vitest";
import { editInstructionsTool } from "../../../src/tools/edit-instructions.tool.js";

describe("editInstructionsTool", () => {
  it("should exist with execute function", () => {
    expect(editInstructionsTool).toBeDefined();
    expect(typeof (editInstructionsTool as any).execute).toBe("function");
  });

  it("should have inputSchema", () => {
    expect((editInstructionsTool as any).inputSchema).toBeDefined();
  });

  it("should have description about instructions", () => {
    expect((editInstructionsTool as any).description).toContain("instructions");
  });
});
