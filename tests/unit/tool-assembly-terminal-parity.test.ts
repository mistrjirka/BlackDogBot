import { describe, expect, it, vi, afterEach } from "vitest";
import { ChannelRegistryService } from "../../src/services/channel-registry.service.js";
import { assembleToolsForChat } from "../../src/agent/tool-assembly.js";
import { FileReadTracker } from "../../src/tools/index.js";
import { scheduleCreateTool, scheduleEditTool } from "../../src/tools/merged-tools.tool.js";
import {
  addOnceToolInputSchema,
  addIntervalToolInputSchema,
  editOnceToolInputSchema,
  editIntervalToolInputSchema,
} from "../../src/shared/schemas/tool-schemas.js";
import { createAgentBaseToolSet, createBaseToolSet } from "../../src/agent/tool-assembly.js";

vi.mock("../../src/utils/per-table-tools.js", () => ({
  buildPerTableToolsAsync: async () => ({ dbStatus: "ok", tools: {} }),
}));

const sender = async () => null;
const pty = ["run_cmd_input", "get_cmd_status", "get_cmd_output", "wait_for_cmd", "stop_cmd"];
const oldScheduling = ["add_once", "add_interval", "edit_once", "edit_interval"];

describe("chat vs cron tool-capability parity", () => {
  afterEach(() => vi.restoreAllMocks());

  it("retains dedicated PTY tools and all other core tools for full chats", async () => {
    vi.spyOn(ChannelRegistryService.getInstance(), "getPermission").mockReturnValue("full");
    const built = await assembleToolsForChat("tool-audit-test", sender, new FileReadTracker());
    const cronCore = createAgentBaseToolSet(sender, new FileReadTracker());
    for (const name of pty) {
      expect(built[name], name).toBeDefined();
      expect(built[name].inputSchema).toBe(cronCore[name].inputSchema);
    }
    expect(built.process).toBeUndefined();
    for (const name of oldScheduling) expect(built[name]).toBeUndefined();
    // Unmerged tools must survive the catalog migration without schema changes.
    const baseline = createBaseToolSet(sender, new FileReadTracker());
    for (const [name, legacy] of Object.entries(baseline)) {
      if (oldScheduling.includes(name)) continue;
      expect(built[name], `lost tool ${name}`).toBeDefined();
      expect(built[name].inputSchema, `altered schema for ${name}`).toBe(legacy.inputSchema);
    }
    for (const name of ["schedule_create", "schedule_edit", "run_cmd", "run_code", "apply_patch",
      "read_file", "write_file", "append_file", "edit_file",
      "search_knowledge", "add_knowledge", "edit_knowledge", "fetch_rss",
      "list_timed", "get_timed", "remove_timed", "edit_instructions"]) {
      // run_code is added only with an actual blackboard getter.
      if (name !== "run_code") expect(built[name], name).toBeDefined();
    }
    expect(Object.keys(built)).toEqual([...Object.keys(built)].sort((a, b) => a.localeCompare(b, "en")));
  });

  it("preserves read-only PTY observation without enabling PTY input or stop", async () => {
    vi.spyOn(ChannelRegistryService.getInstance(), "getPermission").mockReturnValue("read_only");
    const built = await assembleToolsForChat("tool-audit-read-only", sender, new FileReadTracker());
    expect(built.get_cmd_status).toBeDefined();
    expect(built.get_cmd_output).toBeDefined();
    for (const name of ["run_cmd", "run_cmd_input", "wait_for_cmd", "stop_cmd",
      "process", "apply_patch", "schedule_create", "schedule_edit", "write_file"]) {
      expect(built[name], name).toBeUndefined();
    }
  });

  it("retains cron's dedicated PTY tools while chat scheduling operations are merged", () => {
    const core = createAgentBaseToolSet(sender, new FileReadTracker());
    for (const name of pty) expect(core[name], name).toBeDefined();
  });

  it("merged scheduling schemas represent every legacy parameter", () => {
    const originalSchemas = [
      [scheduleCreateTool.inputSchema, addOnceToolInputSchema.innerType().shape],
      [scheduleCreateTool.inputSchema, addIntervalToolInputSchema.innerType().shape],
      [scheduleEditTool.inputSchema, editOnceToolInputSchema.innerType().shape],
      [scheduleEditTool.inputSchema, editIntervalToolInputSchema.innerType().shape],
    ] as const;
    for (const [merged, legacy] of originalSchemas) {
      const fields = Object.keys(merged.shape);
      expect(Object.keys(legacy).filter((field) => !fields.includes(field))).toEqual([]);
    }
    expect(scheduleEditTool.inputSchema.shape.enabled).toBeDefined();
  });
});
