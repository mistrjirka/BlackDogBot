import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { countRequestBodyTokens, type IRequestTokenBreakdown } from "../../src/utils/request-token-counter.js";
import { resetSingletons } from "../utils/test-helpers.js";
import { LoggerService } from "../../src/services/logger.service.js";
import path from "node:path";
import os from "node:os";

//#region Tests

describe("countRequestBodyTokens", () => {
  beforeEach(async () => {
    resetSingletons();
    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(os.tmpdir(), "test-logs"));
  });

  afterEach(() => {
    resetSingletons();
  });

  it("should return all zeros for empty body", () => {
    const emptyBody: string = JSON.stringify({});
    const breakdown: IRequestTokenBreakdown = countRequestBodyTokens(emptyBody);

    // Arrange / Act / Assert
    expect(breakdown.messages).toBe(0);
    expect(breakdown.tools).toBe(0);
    expect(breakdown.system).toBe(0);
    expect(breakdown.messageCount).toBe(0);
    expect(breakdown.toolCount).toBe(0);
    expect(breakdown.total).toBeGreaterThan(0); // JSON overhead
  });

  it("should count message tokens correctly", () => {
    // Arrange
    const requestBody: string = JSON.stringify({
      messages: [
        { role: "user", content: "Hello world" },
        { role: "assistant", content: "Hi there!" },
      ],
    });

    // Act
    const breakdown: IRequestTokenBreakdown = countRequestBodyTokens(requestBody);

    // Assert
    expect(breakdown.messageCount).toBe(2);
    expect(breakdown.messages).toBeGreaterThan(0); // Should have tokens for message content
    expect(breakdown.toolCount).toBe(0);
    expect(breakdown.tools).toBe(0);
    expect(breakdown.system).toBe(0);
    expect(breakdown.total).toBeGreaterThan(0);
    // Note: total may be less than messages due to per-message overhead (15 tokens/msg)
    // and tokenization differences between full JSON vs components
  });

  it("should count tool tokens correctly", () => {
    // Arrange
    const requestBody: string = JSON.stringify({
      messages: [{ role: "user", content: "Use the calculator" }],
      tools: [
        {
          type: "function",
          function: {
            name: "calculate",
            description: "Performs mathematical calculations",
            parameters: {
              type: "object",
              properties: {
                expression: { type: "string" },
              },
            },
          },
        },
      ],
    });

    // Act
    const breakdown: IRequestTokenBreakdown = countRequestBodyTokens(requestBody);

    // Assert
    expect(breakdown.messageCount).toBe(1);
    expect(breakdown.toolCount).toBe(1);
    expect(breakdown.tools).toBeGreaterThan(0); // Should have tokens for tool definition
    expect(breakdown.messages).toBeGreaterThan(0);
    expect(breakdown.total).toBeGreaterThan(0);
    // Note: total = messages + tools + system + overhead (overhead can be negative)
  });

  it("should count system tokens correctly", () => {
    // Arrange
    const systemPrompt: string = "You are a helpful assistant that answers questions concisely.";
    const requestBody: string = JSON.stringify({
      messages: [{ role: "user", content: "Hello" }],
      system: systemPrompt,
    });

    // Act
    const breakdown: IRequestTokenBreakdown = countRequestBodyTokens(requestBody);

    // Assert
    expect(breakdown.messageCount).toBe(1);
    expect(breakdown.system).toBeGreaterThan(0); // Should have tokens for system prompt
    expect(breakdown.messages).toBeGreaterThan(0);
    expect(breakdown.total).toBeGreaterThanOrEqual(breakdown.messages + breakdown.system);
  });

  it("should count full request with messages, tools, and system", () => {
    // Arrange
    const requestBody: string = JSON.stringify({
      messages: [
        { role: "user", content: "What's the weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_123",
              type: "function",
              function: { name: "get_weather", arguments: '{"location":"NYC"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_123", content: "Sunny, 72F" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
            },
          },
        },
      ],
      system: "You are a weather assistant.",
    });

    // Act
    const breakdown: IRequestTokenBreakdown = countRequestBodyTokens(requestBody);

    // Assert
    expect(breakdown.messageCount).toBe(3);
    expect(breakdown.toolCount).toBe(1);
    expect(breakdown.messages).toBeGreaterThan(0);
    expect(breakdown.tools).toBeGreaterThan(0);
    expect(breakdown.system).toBeGreaterThan(0);
    
    // Total should approximately equal sum of components
    // Note: overhead can be negative due to tokenization differences between full body and components
    const sum: number = breakdown.messages + breakdown.tools + breakdown.system + breakdown.overhead;
    expect(breakdown.total).toBe(sum);
  });

  it("should handle invalid JSON gracefully", () => {
    // Arrange
    const invalidBody: string = "{ this is not valid JSON }";

    // Act
    const breakdown: IRequestTokenBreakdown = countRequestBodyTokens(invalidBody);

    // Assert - should return all zeros on parse error
    expect(breakdown.total).toBe(0);
    expect(breakdown.messages).toBe(0);
    expect(breakdown.tools).toBe(0);
    expect(breakdown.system).toBe(0);
    expect(breakdown.overhead).toBe(0);
    expect(breakdown.messageCount).toBe(0);
    expect(breakdown.toolCount).toBe(0);
  });

  it("should count array content in messages", () => {
    // Arrange
    const requestBody: string = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,..." } },
          ],
        },
      ],
    });

    // Act
    const breakdown: IRequestTokenBreakdown = countRequestBodyTokens(requestBody);

    // Assert
    expect(breakdown.messageCount).toBe(1);
    expect(breakdown.messages).toBeGreaterThan(0); // Should count array content
    expect(breakdown.total).toBeGreaterThan(0);
    // Array content is stringified, so messages count includes JSON structure
  });
});

//#endregion Tests
