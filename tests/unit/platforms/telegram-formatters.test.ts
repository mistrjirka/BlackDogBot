import { describe, expect, it } from "vitest";

import { formatStepTraceLines } from "../../../src/platforms/telegram/telegram-formatters.js";
import type { IToolCallSummary } from "../../../src/agent/types.js";

describe("Telegram formatters", () => {
  describe("formatStepTraceLines with results", () => {
    it("should show success result for add_cron", () => {
      const toolCalls: IToolCallSummary[] = [{
        name: "add_cron",
        input: {
          name: "Hourly fetch",
          scheduleType: "interval",
          scheduleIntervalMs: 3600000,
          tools: ["fetch_rss", "send_message"],
          instructions: "Fetch RSS feed and notify me",
          notifyUser: true,
          description: "Hourly RSS fetch",
        },
        result: {
          success: true,
          taskId: "abc123",
        },
      }];

      const result = formatStepTraceLines(1, toolCalls);

      expect(result).toContain("Step 1");
      expect(result).toContain("add_cron");
      expect(result).toContain('"Hourly fetch"');
      expect(result).toContain("3600000ms");
      expect(result).toContain("[fetch_rss, send_message]");
      expect(result).toContain("✅ Created task abc123");
    });

    it("should show error result for add_cron with verifier rejection", () => {
      const toolCalls: IToolCallSummary[] = [{
        name: "add_cron",
        input: {
          name: "Bad task",
          scheduleType: "interval",
          scheduleIntervalMs: 60000,
          tools: ["fetch_rss"],
          instructions: "Do something vague",
          notifyUser: true,
          description: "A bad task",
        },
        result: {
          success: false,
          error: "CRON REJECTED. The instructions are ambiguous. Missing context: no database table specified for write operations.",
        },
      }];

      const result = formatStepTraceLines(1, toolCalls);

      expect(result).toContain("Step 1");
      expect(result).toContain("❌ CRON REJECTED");
      expect(result).toContain("no database table specified");
    });

    it("should show success result for edit_cron", () => {
      const toolCalls: IToolCallSummary[] = [{
        name: "edit_cron",
        input: {
          taskId: "abc123",
          enabled: false,
        },
        result: {
          success: true,
          task: {
            taskId: "abc123",
            name: "Hourly fetch",
          },
        },
      }];

      const result = formatStepTraceLines(1, toolCalls);

      expect(result).toContain("Step 1");
      expect(result).toContain("edit_cron");
      expect(result).toContain("abc123");
      expect(result).toContain("enabled=false");
      expect(result).toContain("✅ Updated task abc123");
    });

    it("should show generic result for non-cron tools", () => {
      const toolCalls: IToolCallSummary[] = [{
        name: "create_database",
        input: {
          databaseName: "my_db",
        },
        result: {
          success: true,
          message: "Database my_db created",
        },
      }];

      const result = formatStepTraceLines(1, toolCalls);

      expect(result).toContain("Step 1");
      expect(result).toContain("create_database");
      expect(result).toContain("✅ Database my_db created");
    });

    it("should show error for failed tools", () => {
      const toolCalls: IToolCallSummary[] = [{
        name: "create_table",
        input: {
          databaseName: "my_db",
          tableName: "test",
          columns: [],
        },
        result: {
          success: false,
          error: "Table already exists",
        },
      }];

      const result = formatStepTraceLines(1, toolCalls);

      expect(result).toContain("Step 1");
      expect(result).toContain("❌ Table already exists");
    });
  });
});
