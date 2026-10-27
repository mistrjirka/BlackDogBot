import { describe, expect, it } from "vitest";
import { VariableStore } from "../../src/utils/variable-store.js";
import { createInspectVariableTool } from "../../src/tools/inspect-variable.tool.js";
import { createRunCodeTool } from "../../src/tools/run-code.tool.js";

function invoke(tool: { execute?: unknown }, input: unknown): Promise<unknown> {
  return (tool.execute as (args: unknown, options: never) => Promise<unknown>)(input, {} as never);
}

describe("large tool results give executable blackboard guidance", () => {
  it("continues from a large browser result without calling the browser again", async () => {
    const store = new VariableStore();
    const html = "<h1>PS4 exploit table</h1>" + " filler".repeat(250) +
      "<table><tr><td>12.50</td><td>userland exploit</td><td>kernel status here</td></tr></table>" +
      " filler".repeat(1100);
    let fetchCount = 0;
    const browserFetch = () => { fetchCount++; return html; };
    const stub = store.maybeCapture("mcp.stealth.browser_read_html", browserFetch(), true) as {
      variable: string; savedToVariable: string; previewOnly: boolean;
      readNextWith: { tool: string; arguments: { name: string; offset: number; maxChars: number } };
      searchWith: { tool: string; arguments: { code: string } };
      preview: string;
    };
    expect(stub.savedToVariable).toBe(stub.variable);
    expect(stub.previewOnly).toBe(true);
    expect(stub.readNextWith.tool).toBe("inspect_variable");
    expect(stub.searchWith.tool).toBe("run_code");
    expect(stub.preview).not.toContain("12.50");

    const read = await invoke(createInspectVariableTool(() => store), stub.readNextWith.arguments) as {
      content: string; totalChars: number; nextOffset: number | null;
    };
    expect(read.content).toContain("12.50");
    expect(read.totalChars).toBe(html.length);
    expect(read.nextOffset).not.toBeNull();
    const run = await invoke(createRunCodeTool(() => store), {
      code: `const s = ${stub.variable}; const p = s.indexOf("12.50"); print(s.slice(p, p+80));`,
    }) as { ok: boolean; display: string };
    expect(run.ok).toBe(true);
    expect(run.display).toContain("12.50");
    expect(fetchCount).toBe(1);
  });
});
