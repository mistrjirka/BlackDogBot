import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";

import { runCmdInputToolInputSchema } from "../../../src/shared/schemas/tool-schemas.js";
import { runCmdInputTool } from "../../../src/tools/run-cmd-input.tool.js";

describe("PTY input tool contract", () => {
  it("exposes named control keys without requiring literal text", () => {
    expect(runCmdInputToolInputSchema.parse({ handleId: "example", controlKey: "CTRL_C" }))
      .toMatchObject({ controlKey: "CTRL_C" });
    expect(runCmdInputToolInputSchema.parse({ handleId: "example", input: "hello" }))
      .toMatchObject({ input: "hello" });
    expect(runCmdInputToolInputSchema.shape.controlKey.description).toContain("DELETE");
    expect(runCmdInputTool.description).toContain("controlKey");
  });

  it("documents JSON escapes as different from printable slash text", () => {
    const description = runCmdInputToolInputSchema.shape.input.description ?? "";
    expect(description).toContain(String.raw`{"input":"\u0003","appendNewline":false}`);
    expect(description).toContain(String.raw`{"input":"\\u0003"}`);
    const decoded = JSON.parse(String.raw`{"input":"\u0003"}`) as { input: string };
    const literal = JSON.parse(String.raw`{"input":"\\u0003"}`) as { input: string };
    expect(Buffer.from(decoded.input)).toEqual(Buffer.from([3]));
    expect(Buffer.from(literal.input)).toEqual(Buffer.from([92, 117, 48, 48, 48, 51]));
  });

  it("keeps the primary instructions concise and consistent", async () => {
    const prompt = await fs.readFile("src/defaults/prompts/main-agent.md", "utf8");
    const skill = await fs.readFile("skills/coding-workflow/SKILL.md", "utf8");
    expect(prompt).toContain('controlKey: "CTRL_C"');
    expect(skill).toContain('"controlKey":"CTRL_C"');
    expect(prompt).toContain("PTY echo");
    expect(skill).toContain("terminal echo");
  });
});
