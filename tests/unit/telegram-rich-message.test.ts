import { Bot, GrammyError, HttpError } from "grammy";
import { describe, expect, it, vi } from "vitest";

import { TelegramAdapter } from "../../src/platforms/telegram/adapter.js";
import type { IOutgoingMessage } from "../../src/shared/types/messaging.types.js";
import { ChatNotFoundError } from "../../src/utils/error.js";
import { getTelegramRichMarkdown } from "../../src/utils/telegram-format.js";

const table = "# Diagnostics\n\n| Test | Result | Notes |\n| :--- | ---: | --- |\n| DNS | **OK** | |\n| HTTPS | `443` | [Link](https://example.com) |";
const outgoing = (text: string, replyToMessageId: string | null = null): IOutgoingMessage => ({
  platform: "telegram", userId: "123", text, replyToMessageId,
});
const baseMessage = { message_id: 1, date: 0, chat: { id: 123, type: "private" as const, first_name: "Test" } };

function setup() {
  const bot = new Bot("123:fake");
  const rich = vi.spyOn(bot.api, "sendRichMessage").mockResolvedValue({ ...baseMessage, rich_message: { blocks: [] } });
  const plain = vi.spyOn(bot.api, "sendMessage").mockResolvedValue({ ...baseMessage, text: "sent" });
  return { adapter: new TelegramAdapter(bot), rich, plain };
}

function rejection(code: number, description: string): GrammyError {
  return new GrammyError("send failed", { ok: false, error_code: code, description }, "sendRichMessage", {});
}

describe("getTelegramRichMarkdown", () => {
  it("preserves Markdown, alignment, links, and empty cells", () => {
    expect(getTelegramRichMarkdown(table)).toBe(table);
  });
  it("does not mistake fenced code or ordinary prose for a table", () => {
    expect(getTelegramRichMarkdown("```md\n" + table + "\n```")).toBeNull();
    expect(getTelegramRichMarkdown("Hello | world")).toBeNull();
  });
  it("preserves the existing handling of reasoning tags", () => {
    expect(getTelegramRichMarkdown("<think>note</think>\n\n" + table)).toContain("> note");
  });
  it("does not exceed the rich text limit", () => {
    expect(getTelegramRichMarkdown(table + "\n" + "x".repeat(32_768))).toBeNull();
  });
});

describe("TelegramAdapter rich tables", () => {
  it("sends native rich Markdown with the original reply target", async () => {
    const { adapter, rich, plain } = setup();
    expect(await adapter.sendMessageAsync(outgoing(table, "42"))).toBe("1");
    expect(rich).toHaveBeenCalledExactlyOnceWith("123", { markdown: table }, {
      reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    });
    expect(plain).not.toHaveBeenCalled();
  });
  it("keeps native rich messages intact beyond the legacy 4096-character limit", async () => {
    const { adapter, rich, plain } = setup();
    const longTableMessage = table + "\n\n" + "x".repeat(5000);
    await adapter.sendMessageAsync(outgoing(longTableMessage));
    expect(rich).toHaveBeenCalledExactlyOnceWith("123", { markdown: longTableMessage }, {});
    expect(plain).not.toHaveBeenCalled();
  });
  it("keeps ordinary replies on the legacy path", async () => {
    const { adapter, rich, plain } = setup();
    await adapter.sendMessageAsync(outgoing("**Hello**"));
    expect(rich).not.toHaveBeenCalled();
    expect(plain).toHaveBeenCalledOnce();
  });
  it.each([400, 404])("falls back to legacy HTML after explicit rejection %s", async (code) => {
    const { adapter, rich, plain } = setup();
    rich.mockRejectedValueOnce(rejection(code, "Unsupported rich content"));
    await expect(adapter.sendMessageAsync(outgoing(table, "42"))).resolves.toBe("1");
    expect(plain).toHaveBeenCalledExactlyOnceWith("123", expect.stringContaining("Table (3 columns)"), {
      parse_mode: "HTML", reply_parameters: { message_id: 42, allow_sending_without_reply: true },
    });
  });
  it.each([rejection(429, "Too Many Requests"), rejection(500, "Internal error"), new HttpError("Network error", new Error("timeout"))])("propagates transient failure without a second send", async (error) => {
    const { adapter, rich, plain } = setup();
    rich.mockRejectedValueOnce(error);
    await expect(adapter.sendMessageAsync(outgoing(table))).rejects.toBe(error);
    expect(plain).not.toHaveBeenCalled();
  });
  it("preserves the chat-not-found behavior", async () => {
    const { adapter, rich, plain } = setup();
    rich.mockRejectedValueOnce(rejection(400, "Bad Request: chat not found"));
    await expect(adapter.sendMessageAsync(outgoing(table))).rejects.toBeInstanceOf(ChatNotFoundError);
    expect(plain).not.toHaveBeenCalled();
  });
});
