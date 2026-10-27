import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { ToolExecutionOptions } from "ai";
import { applyPatchTool } from "../../../src/tools/apply-patch.tool.js";
import { processTool, scheduleCreateTool, scheduleEditTool } from "../../../src/tools/merged-tools.tool.js";
import { canonicalToolCatalog, conciseToolDescriptions } from "../../../src/agent/tool-descriptions.js";
import { isToolAllowed } from "../../../src/helpers/tool-registry.js";
import { editOnceToolInputSchema, editIntervalToolInputSchema } from "../../../src/shared/schemas/tool-schemas.js";

const options = {} as ToolExecutionOptions<unknown>;
const invoke = async (tool: { execute?: unknown }, input: unknown) =>
  await (tool.execute as (a: unknown, b: ToolExecutionOptions<unknown>) => Promise<unknown>)(input, options) as Record<string, unknown>;

describe("stable merged tool interfaces", () => {
  it("serializes identical tool catalogs regardless of insertion order", () => {
    const abc = { z_tool: { inputSchema: {} as never }, a_tool: { inputSchema: {} as never } };
    const bac = { a_tool: abc.a_tool, z_tool: abc.z_tool };
    expect(JSON.stringify(canonicalToolCatalog(abc))).toBe(JSON.stringify(canonicalToolCatalog(bac)));
    expect(Object.keys(canonicalToolCatalog(abc))).toEqual(["a_tool", "z_tool"]);
  });

  it("retains permission boundaries", () => {
    for (const name of ["apply_patch", "process", "schedule_create", "schedule_edit"]) {
      expect(isToolAllowed(name, "full")).toBe(true);
      expect(isToolAllowed(name, "read_only")).toBe(false);
    }
  });

  it("shortens descriptions without changing contracts or original tools", () => {
    const orig = { run_cmd: { description: "a".repeat(500), inputSchema: {} as never } };
    const changed = conciseToolDescriptions(orig);
    expect(changed.run_cmd.description!.length).toBeLessThan(240);
    expect(changed.run_cmd.inputSchema).toBe(orig.run_cmd.inputSchema);
    expect(orig.run_cmd.description).toHaveLength(500);
    expect(conciseToolDescriptions(orig).run_cmd.description).toBe(changed.run_cmd.description);
  });

  it("makes the stealth HTML paging limitation visible in the tool description", () => {
    const orig = { "mcp.stealth.browser_read_html": { description: "Read page HTML", inputSchema: {} as never } };
    const tool = conciseToolDescriptions(orig)["mcp.stealth.browser_read_html"];
    expect(tool.description).toContain("NO offset/start/limit");
    expect(tool.description).toContain("inspect_variable");
    expect(tool.inputSchema).toBe(orig["mcp.stealth.browser_read_html"].inputSchema);
  });

  it("rejects missing schedule fields using old validators", async () => {
    const once = await invoke(scheduleCreateTool, { kind: "once", name: "x" });
    expect(once.success).toBe(false);
    expect(String(once.error)).toContain("description");
    const recurring = await invoke(scheduleCreateTool, { kind: "interval", name: "x" });
    expect(recurring.success).toBe(false);
    const edit = await invoke(scheduleEditTool, { kind: "once", taskId: "" });
    expect(edit.success).toBe(false);
  });

  it("preserves enable/disable task editing for both schedule types", () => {
    const once = scheduleEditTool.inputSchema.parse({ kind: "once", taskId: "task-1", enabled: false });
    const interval = scheduleEditTool.inputSchema.parse({ kind: "interval", taskId: "task-2", enabled: true });
    expect(once.enabled).toBe(false);
    expect(interval.enabled).toBe(true);
    const { kind: onceKind, ...onceLegacy } = once;
    const { kind: intervalKind, ...intervalLegacy } = interval;
    expect(onceKind).toBe("once");
    expect(intervalKind).toBe("interval");
    expect(editOnceToolInputSchema.parse(onceLegacy).enabled).toBe(false);
    expect(editIntervalToolInputSchema.parse(intervalLegacy).enabled).toBe(true);
    expect(scheduleCreateTool.inputSchema.safeParse({ kind: "once", enabled: false }).success).toBe(true);
    expect("enabled" in scheduleCreateTool.inputSchema.parse({ kind: "once", enabled: false })).toBe(false);
  });

  it("dispatches process actions through existing legacy handlers", async () => {
    const status = await invoke(processTool, { action: "status", handleId: "missing-handle" });
    expect(status.handleId).toBe("missing-handle");
    const badInput = await invoke(processTool, { action: "input", handleId: "missing-handle" });
    expect(badInput.success).toBe(false);
    const badWait = await invoke(processTool, { action: "wait", handleId: "missing-handle" });
    expect(badWait.status).toBe("failed");
  });

  it("applies multi-file patches atomically and rejects wrong context", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "blackdog-patch-"));
    try {
      await fs.writeFile(path.join(root, "one.txt"), "hello\n", "utf8");
      await fs.writeFile(path.join(root, "two.txt"), "world\n", "utf8");
      const patch = [
        "--- a/one.txt", "+++ b/one.txt", "@@ -1 +1 @@", "-hello", "+HELLO",
        "--- a/two.txt", "+++ b/two.txt", "@@ -1 +1 @@", "-world", "+WORLD", "",
      ].join("\n");
      const result = await invoke(applyPatchTool, { cwd: root, patch });
      expect(result.success).toBe(true);
      expect(await fs.readFile(path.join(root, "one.txt"), "utf8")).toBe("HELLO\n");
      expect(await fs.readFile(path.join(root, "two.txt"), "utf8")).toBe("WORLD\n");
      const second = await invoke(applyPatchTool, { cwd: root, patch });
      expect(second.success).toBe(false);
      expect(await fs.readFile(path.join(root, "one.txt"), "utf8")).toBe("HELLO\n");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
