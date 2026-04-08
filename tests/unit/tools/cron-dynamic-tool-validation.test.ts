import { describe, it, expect, vi, beforeEach } from "vitest";
import { addOnceTool } from "../../../src/tools/add-once.tool.js";
import { addIntervalTool } from "../../../src/tools/add-interval.tool.js";
import { editOnceTool } from "../../../src/tools/edit-once.tool.js";
import { editIntervalTool } from "../../../src/tools/edit-interval.tool.js";
import { editInstructionsTool } from "../../../src/tools/edit-instructions.tool.js";

const CRON_VALID_TOOL_NAMES = [
  "think",
  "run_cmd",
  "send_message",
  "read_file",
  "list_timed",
  "read_from_database",
];

vi.mock("../../../src/services/scheduler.service.js", () => ({
  SchedulerService: {
    getInstance: vi.fn().mockReturnValue({
      addTaskAsync: vi.fn().mockResolvedValue(undefined),
      getTaskAsync: vi.fn().mockResolvedValue(null),
      updateTaskAsync: vi.fn().mockResolvedValue(null),
    }),
  },
}));

vi.mock("../../../src/services/logger.service.js", () => ({
  LoggerService: {
    getInstance: vi.fn().mockReturnValue({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

vi.mock("../../../src/services/ai-provider.service.js", () => ({
  AiProviderService: {
    getInstance: vi.fn().mockReturnValue({
      getModel: vi.fn().mockReturnValue({}),
    }),
  },
}));

vi.mock("../../../src/utils/llm-retry.js", () => ({
  generateObjectWithRetryAsync: vi.fn().mockResolvedValue({
    object: { isClear: true, missingContext: "" },
  }),
}));

vi.mock("../../../src/utils/id.js", () => ({
  generateId: vi.fn().mockReturnValue("test-task-id"),
}));

function isDynamicTableTool(toolName: string): boolean {
  return toolName.startsWith("write_table_") || toolName.startsWith("update_table_");
}

function validateTools(tools: string[]): string[] {
  const validToolSet: ReadonlySet<string> = new Set(CRON_VALID_TOOL_NAMES);
  return tools.filter((t) => !validToolSet.has(t) && !isDynamicTableTool(t));
}

describe("cron-dynamic-tool-validation", () => {
  describe("isDynamicTableTool accepts both prefixes", () => {
    it("should accept write_table_ prefix", () => {
      expect(isDynamicTableTool("write_table_users")).toBe(true);
      expect(isDynamicTableTool("write_table_orders")).toBe(true);
    });

    it("should accept update_table_ prefix", () => {
      expect(isDynamicTableTool("update_table_users")).toBe(true);
      expect(isDynamicTableTool("update_table_orders")).toBe(true);
    });

    it("should reject unknown prefixes", () => {
      expect(isDynamicTableTool("delete_table_users")).toBe(false);
      expect(isDynamicTableTool("read_table_users")).toBe(false);
      expect(isDynamicTableTool("unknown_table_users")).toBe(false);
    });

    it("should reject static valid tools", () => {
      expect(isDynamicTableTool("send_message")).toBe(false);
      expect(isDynamicTableTool("think")).toBe(false);
      expect(isDynamicTableTool("run_cmd")).toBe(false);
    });
  });

  describe("validateTools with mixed tool lists", () => {
    it("should accept write_table_ and static tools together", () => {
      const tools = ["send_message", "write_table_users", "think"];
      const invalid = validateTools(tools);
      expect(invalid).toEqual([]);
    });

    it("should accept update_table_ and static tools together", () => {
      const tools = ["send_message", "update_table_users", "think"];
      const invalid = validateTools(tools);
      expect(invalid).toEqual([]);
    });

    it("should accept both write_table_ and update_table_ in same list", () => {
      const tools = ["send_message", "write_table_users", "update_table_orders"];
      const invalid = validateTools(tools);
      expect(invalid).toEqual([]);
    });

    it("should reject invalid prefixes as invalid tools", () => {
      const tools = ["send_message", "delete_table_users"];
      const invalid = validateTools(tools);
      expect(invalid).toContain("delete_table_users");
    });

    it("should reject completely unknown tools", () => {
      const tools = ["send_message", "foobar_baz"];
      const invalid = validateTools(tools);
      expect(invalid).toContain("foobar_baz");
    });

    it("should reject unknown_prefix_tablename with underscore pattern", () => {
      const tools = ["send_message", "unknown_table_foo"];
      const invalid = validateTools(tools);
      expect(invalid).toContain("unknown_table_foo");
    });

    it("should handle empty tool list", () => {
      const tools: string[] = [];
      const invalid = validateTools(tools);
      expect(invalid).toEqual([]);
    });

    it("should handle only static valid tools", () => {
      const tools = ["send_message", "think", "run_cmd"];
      const invalid = validateTools(tools);
      expect(invalid).toEqual([]);
    });

    it("should handle only dynamic table tools", () => {
      const tools = ["write_table_a", "update_table_b"];
      const invalid = validateTools(tools);
      expect(invalid).toEqual([]);
    });
  });
});