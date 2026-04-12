import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSet } from "ai";

import { ToolHotReloadService } from "../../../src/services/tool-hot-reload.service.js";
import { resetSingletons } from "../../utils/test-helpers.js";

// Use vi.hoisted to ensure the mock is available at hoisting time
const mockBuildPerTableToolsWithUpdatesAsync = vi.hoisted(() => vi.fn());

vi.mock("../../../src/utils/per-table-tools.js", () => ({
  buildPerTableToolsWithUpdatesAsync: mockBuildPerTableToolsWithUpdatesAsync,
}));

describe("ToolHotReloadService", () => {
  //#region Data Members

  let service: ToolHotReloadService;
  let mockCallback: ReturnType<typeof vi.fn>;

  //#endregion Data Members

  //#region Constructors

  beforeEach(async () => {
    resetSingletons();
    vi.clearAllMocks();
    service = ToolHotReloadService.getInstance();
    mockCallback = vi.fn();
  });

  //#endregion Constructors

  //#region Public Methods

  describe("registerRebuildCallback", () => {
    it("registers a callback for a chatId", () => {
      service.registerRebuildCallback("chat-123", mockCallback);

      service.unregisterRebuildCallback("chat-123");
    });

    it("allows multiple callbacks for different chatIds", () => {
      const callback2 = vi.fn();

      service.registerRebuildCallback("chat-1", mockCallback);
      service.registerRebuildCallback("chat-2", callback2);

      service.unregisterRebuildCallback("chat-1");
      service.unregisterRebuildCallback("chat-2");
    });
  });

  describe("unregisterRebuildCallback", () => {
    it("removes the callback for a chatId", async () => {
      service.registerRebuildCallback("chat-123", mockCallback);
      service.unregisterRebuildCallback("chat-123");

      // After unregistering, triggerRebuildAsync should return false
      const result = await service.triggerRebuildAsync("chat-123");
      expect(result).toBe(false);
      expect(mockCallback).not.toHaveBeenCalled();
    });
  });

  describe("triggerRebuildAsync", () => {
    it("returns false when no callback is registered for chatId", async () => {
      const result = await service.triggerRebuildAsync("nonexistent-chat");

      expect(result).toBe(false);
      expect(mockCallback).not.toHaveBeenCalled();
    });

    it("calls callback with dynamically built per-table tools", async () => {
      const mockWriteTools: ToolSet = {
        write_table_articles: {} as any,
        write_table_users: {} as any,
      };
      const mockUpdateTools: ToolSet = {
        update_table_articles: {} as any,
        update_table_users: {} as any,
      };

      mockBuildPerTableToolsWithUpdatesAsync.mockResolvedValue({
        write: { tools: mockWriteTools, dbStatus: "ok" },
        update: { tools: mockUpdateTools, dbStatus: "ok" },
      });

      service.registerRebuildCallback("chat-123", mockCallback);

      const result = await service.triggerRebuildAsync("chat-123");

      expect(result).toBe(true);
      expect(mockCallback).toHaveBeenCalledTimes(1);
      expect(mockCallback).toHaveBeenCalledWith({
        write_table_articles: {},
        write_table_users: {},
        update_table_articles: {},
        update_table_users: {},
      });
    });

    it("includes newly created table tools after hot-reload", async () => {
      // Initially only one table exists
      const initialWriteTools: ToolSet = {
        write_table_articles: {} as any,
      };
      const initialUpdateTools: ToolSet = {
        update_table_articles: {} as any,
      };

      // After hot-reload, a new table was created
      const updatedWriteTools: ToolSet = {
        write_table_articles: {} as any,
        write_table_new_table: {} as any,
      };
      const updatedUpdateTools: ToolSet = {
        update_table_articles: {} as any,
        update_table_new_table: {} as any,
      };

      // First call returns initial tools
      mockBuildPerTableToolsWithUpdatesAsync
        .mockResolvedValueOnce({
          write: { tools: initialWriteTools, dbStatus: "ok" },
          update: { tools: initialUpdateTools, dbStatus: "ok" },
        })
        // Subsequent calls return updated tools (simulating new table creation)
        .mockResolvedValueOnce({
          write: { tools: updatedWriteTools, dbStatus: "ok" },
          update: { tools: updatedUpdateTools, dbStatus: "ok" },
        });

      service.registerRebuildCallback("chat-123", mockCallback);

      // First trigger - only initial tools
      await service.triggerRebuildAsync("chat-123");

      // Simulate create_table creating a new table, then trigger again
      await service.triggerRebuildAsync("chat-123");

      // The second call should have included the new table tools
      expect(mockBuildPerTableToolsWithUpdatesAsync).toHaveBeenCalledTimes(2);
      expect(mockCallback).toHaveBeenCalledTimes(2);
      expect(mockCallback).toHaveBeenLastCalledWith({
        write_table_articles: {},
        write_table_new_table: {},
        update_table_articles: {},
        update_table_new_table: {},
      });
    });

    it("handles buildPerTableToolsWithUpdatesAsync throwing an error gracefully", async () => {
      mockBuildPerTableToolsWithUpdatesAsync.mockRejectedValue(
        new Error("Database connection failed"),
      );

      service.registerRebuildCallback("chat-123", mockCallback);

      const result = await service.triggerRebuildAsync("chat-123");

      expect(result).toBe(false);
      expect(mockCallback).not.toHaveBeenCalled();
    });
  });

  //#endregion Public Methods
});
