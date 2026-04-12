import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildCronToolContextBlockAsync } from "../../../src/utils/cron-tool-context.js";

vi.mock("../../../src/shared/constants/cron-descriptions.js", () => ({
  CRON_TOOL_DESCRIPTIONS: {
    send_message: "Send a message to the user.",
    think: "Think about something.",
  },
}));

vi.mock("../../../src/utils/per-table-tools.js", () => ({
  buildPerTableToolsAsync: vi.fn().mockResolvedValue({
    tools: {
      write_table_users: {
        description: "Insert rows into the 'users' table.",
      },
      write_table_orders: {
        description: "Insert rows into the 'orders' table.",
      },
    },
    dbStatus: "ok" as const,
  }),
  buildUpdateTableToolsAsync: vi.fn().mockResolvedValue({
    tools: {
      update_table_users: {
        description: "Update rows in the 'users' table.",
      },
      update_table_products: {
        description: "Update rows in the 'products' table.",
      },
    },
    dbStatus: "ok" as const,
  }),
}));

describe("cron-tool-context", () => {
  describe("buildCronToolContextBlockAsync", () => {
    it("should include static tool descriptions", async () => {
      const result = await buildCronToolContextBlockAsync(["send_message"]);
      expect(result).toContain("send_message");
      expect(result).toContain("Send a message to the user.");
    });

    it("should include dynamic write_table_ descriptions", async () => {
      const result = await buildCronToolContextBlockAsync(["write_table_users"]);
      expect(result).toContain("write_table_users");
      expect(result).toContain("Insert rows into the 'users' table.");
    });

    it("should include dynamic update_table_ descriptions", async () => {
      const result = await buildCronToolContextBlockAsync(["update_table_users"]);
      expect(result).toContain("update_table_users");
      expect(result).toContain("Update rows in the 'users' table.");
    });

    it("should include fallback generic description for unknown update_table_ prefix", async () => {
      const result = await buildCronToolContextBlockAsync(["update_table_unknown"]);
      expect(result).toContain("update_table_unknown");
      expect(result).toContain("Update rows in the 'unknown' table");
    });

    it("should include both write and update tools in same block", async () => {
      const result = await buildCronToolContextBlockAsync([
        "send_message",
        "write_table_users",
        "update_table_products",
      ]);
      expect(result).toContain("write_table_users");
      expect(result).toContain("update_table_products");
      expect(result).toContain("Insert rows into the 'users' table.");
      expect(result).toContain("Update rows in the 'products' table.");
    });

    it("should return no tools message for empty array", async () => {
      const result = await buildCronToolContextBlockAsync([]);
      expect(result).toBe("The agent will have no tools available.");
    });

    it("should handle unknown tool with generic message", async () => {
      const result = await buildCronToolContextBlockAsync(["foobar_baz"]);
      expect(result).toContain("foobar_baz");
      expect(result).toContain("(no description available)");
    });

    it("should include both static and dynamic tools", async () => {
      const result = await buildCronToolContextBlockAsync([
        "send_message",
        "think",
        "write_table_orders",
        "update_table_users",
      ]);
      expect(result).toContain("Send a message to the user.");
      expect(result).toContain("Think about something.");
      expect(result).toContain("Insert rows into the 'orders' table.");
      expect(result).toContain("Update rows in the 'users' table.");
    });

    it("should accept update_table_ tool name format", async () => {
      const result = await buildCronToolContextBlockAsync(["update_table_events"]);
      expect(result).toContain("update_table_events");
      expect(result).not.toContain("(no description available)");
    });

    it("should reject unknown prefix but include in output", async () => {
      const result = await buildCronToolContextBlockAsync(["delete_table_junk"]);
      expect(result).toContain("delete_table_junk");
      expect(result).toContain("(no description available)");
    });
  });
});