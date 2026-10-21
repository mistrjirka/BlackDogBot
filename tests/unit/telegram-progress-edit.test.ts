import { describe, expect, it, vi } from "vitest";

import {
  _buildProgressText,
  _parseQueueCommand,
  _tryEditMessageTextAsync,
} from "../../src/platforms/telegram/handler.js";
import type { LoggerService } from "../../src/services/logger.service.js";

const logger = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
} as unknown as LoggerService;

describe("Telegram progress message length", () => {
  it("keeps progress text below the edit limit and preserves the newest steps", () => {
    const stepLogs: string[] = Array.from(
      { length: 40 },
      (_value: unknown, index: number): string =>
        `Step ${index + 1}: run_cmd ${"x".repeat(250)}`,
    );

    const text: string = _buildProgressText("⚙️ Working...", stepLogs);

    expect(text.length).toBeLessThanOrEqual(3900);
    expect(text).toContain("Step 40:");
    expect(text).toContain("earlier steps hidden");
    expect((text.match(/<blockquote/g) ?? []).length).toBe(
      (text.match(/<\/blockquote>/g) ?? []).length,
    );
  });

  it("falls back to the status line when a single step is huge", () => {
    const text: string = _buildProgressText("⚙️ Working...", [`Step 1: ${"x".repeat(6000)}`]);

    expect(text).toBe("⚙️ Working...");
  });

  it("renders context usage and a compaction line in the progress trace", () => {
    const text: string = _buildProgressText(
      "⚙️ Working...",
      ["Step 4: run_cmd", "Context compaction: 92k → 41.2k"],
      "📊 54.4k / 128k context (42%)",
    );

    expect(text).toContain("📊 54.4k / 128k context (42%)");
    expect(text).toContain("Context compaction: 92k → 41.2k");
  });
});

describe("editMessageText MESSAGE_TOO_LONG handling", () => {
  it("retries with a truncated edit when Telegram reports MESSAGE_TOO_LONG", async () => {
    const editMessageText = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Call to 'editMessageText' failed! (400: Bad Request: MESSAGE_TOO_LONG)"),
      )
      .mockResolvedValueOnce({});

    const succeeded: boolean = await _tryEditMessageTextAsync(
      { editMessageText },
      logger,
      "chat",
      42,
      "x".repeat(5000),
      "HTML",
      "progress-step",
    );

    expect(succeeded).toBe(true);
    expect(editMessageText).toHaveBeenCalledTimes(2);
    const retriedText: string = editMessageText.mock.calls[1][2] as string;
    expect(retriedText.length).toBeLessThanOrEqual(4096);
  });

  it("treats a no-op edit as success", async () => {
    const editMessageText = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Call to 'editMessageText' failed! (400: Bad Request: message is not modified)"),
      );

    const succeeded: boolean = await _tryEditMessageTextAsync(
      { editMessageText },
      logger,
      "chat",
      42,
      "same text",
      "HTML",
      "progress-step",
    );

    expect(succeeded).toBe(true);
    expect(editMessageText).toHaveBeenCalledTimes(1);
  });

describe("queue command parsing", () => {
  it("extracts the queued text from /queue", () => {
    expect(_parseQueueCommand("/queue continue with the report")).toBe("continue with the report");
    expect(_parseQueueCommand("/queue@BlackDogBot continue")).toBe("continue");
    expect(_parseQueueCommand("/queue")).toBe("");
  });

  it("does not treat normal messages or other commands as /queue", () => {
    expect(_parseQueueCommand("continue with the report")).toBeNull();
    expect(_parseQueueCommand("/steer keep going")).toBeNull();
    expect(_parseQueueCommand("/queuefoo bar")).toBeNull();
  });
});
});
