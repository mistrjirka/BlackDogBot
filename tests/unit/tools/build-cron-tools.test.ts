import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { buildCronSchemasAsync } from "../../../src/tools/build-cron-tools.js";
import { resetSingletons } from "../../utils/test-helpers.js";

vi.mock("../../../src/utils/per-table-tools.js", () => ({
  buildPerTableToolsAsync: vi.fn(),
  buildUpdateTableToolsAsync: vi.fn(),
}));

describe("buildCronSchemasAsync", () => {
  beforeEach(async () => {
    resetSingletons();
    vi.clearAllMocks();
  });

  it("accepts write_table_* tool for an existing table", async () => {
    const { addCronInputSchema } = await buildCronSchemasAsync();

    const result = addCronInputSchema.safeParse({
      name: "Test Task",
      description: "Test",
      instructions: "Do something",
      tools: ["send_message", "write_table_users"],
      scheduleType: "once",
      scheduleRunAt: "2026-01-01T00:00:00Z",
      notifyUser: false,
    });

    expect(result.success).toBe(true);
  });

  it("accepts write_table_* tool for a table that did NOT exist at schema build time", async () => {
    const { addCronInputSchema } = await buildCronSchemasAsync();

    const result = addCronInputSchema.safeParse({
      name: "Test Task",
      description: "Test",
      instructions: "Do something",
      tools: ["send_message", "write_table_messages"],
      scheduleType: "once",
      scheduleRunAt: "2026-01-01T00:00:00Z",
      notifyUser: false,
    });

    expect(result.success).toBe(true);
  });

  it("accepts update_table_* tool for a new table", async () => {
    const { addCronInputSchema } = await buildCronSchemasAsync();

    const result = addCronInputSchema.safeParse({
      name: "Test Task",
      description: "Test",
      instructions: "Do something",
      tools: ["read_from_database", "update_table_orders"],
      scheduleType: "once",
      scheduleRunAt: "2026-01-01T00:00:00Z",
      notifyUser: false,
    });

    expect(result.success).toBe(true);
  });

  it("accepts both write_table_* and update_table_* for the same table", async () => {
    const { addCronInputSchema } = await buildCronSchemasAsync();

    const result = addCronInputSchema.safeParse({
      name: "Test Task",
      description: "Test",
      instructions: "Do something",
      tools: ["write_table_tasks", "update_table_tasks"],
      scheduleType: "once",
      scheduleRunAt: "2026-01-01T00:00:00Z",
      notifyUser: false,
    });

    expect(result.success).toBe(true);
  });

  it("accepts static CRON_VALID_TOOL_NAMES tools", async () => {
    const { addCronInputSchema } = await buildCronSchemasAsync();

    const result = addCronInputSchema.safeParse({
      name: "Test Task",
      description: "Test",
      instructions: "Do something",
      tools: ["send_message", "read_from_database", "searxng"],
      scheduleType: "once",
      scheduleRunAt: "2026-01-01T00:00:00Z",
      notifyUser: false,
    });

    expect(result.success).toBe(true);
  });

  it("rejects arbitrary tool names that are not valid patterns", async () => {
    const { addCronInputSchema } = await buildCronSchemasAsync();

    const result = addCronInputSchema.safeParse({
      name: "Test Task",
      description: "Test",
      instructions: "Do something",
      tools: ["send_message", "completely_invalid_tool_name"],
      scheduleType: "once",
      scheduleRunAt: "2026-01-01T00:00:00Z",
      notifyUser: false,
    });

    expect(result.success).toBe(false);
  });

  it("requires at least one tool", async () => {
    const { addCronInputSchema } = await buildCronSchemasAsync();

    const result = addCronInputSchema.safeParse({
      name: "Test Task",
      description: "Test",
      instructions: "Do something",
      tools: [],
      scheduleType: "once",
      scheduleRunAt: "2026-01-01T00:00:00Z",
      notifyUser: false,
    });

    expect(result.success).toBe(false);
  });

  it("works for edit_cron schema with dynamic tools", async () => {
    const { editCronInputSchema } = await buildCronSchemasAsync();

    const result = editCronInputSchema.safeParse({
      taskId: "task-123",
      tools: ["send_message", "write_table_new_table_created_tomorrow"],
    });

    expect(result.success).toBe(true);
  });

  it("works for edit_cron_instructions schema with dynamic tools", async () => {
    const { editCronInstructionsInputSchema } = await buildCronSchemasAsync();

    const result = editCronInstructionsInputSchema.safeParse({
      taskId: "task-123",
      instructions: "Updated instructions",
      intention: "Adding new tool",
      tools: ["write_table_analytics", "update_table_analytics"],
    });

    expect(result.success).toBe(true);
  });
});
