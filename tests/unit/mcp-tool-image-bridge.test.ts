import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { bridgeMcpToolImages } from "../../src/utils/mcp-tool-image-bridge.js";
import { countRequestBodyTokens } from "../../src/utils/request-token-counter.js";
import { jsonSchemaToZod } from "../../src/utils/json-schema-to-zod.js";

const sampleImage = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLqAAAAAElFTkSuQmCC";

function sampleRequest(base64 = sampleImage): Record<string, unknown> {
  return {
    model: "test",
    messages: [
      { role: "user", content: "Take a screenshot" },
      { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "mcp.playwright.browser_take_screenshot", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: JSON.stringify([
        { type: "text", text: "screenshot available" },
        { type: "file", data: { type: "data", data: base64 }, mediaType: "image/png" },
      ]) },
    ],
  };
}

describe("MCP image to OpenAI-compatible vision bridge", () => {
  it("attaches actual image_url data after tool messages without losing text or call IDs", () => {
    const req = sampleRequest();
    const result = bridgeMcpToolImages(req);
    expect(result.images).toBe(1);
    const messages = req.messages as Record<string, unknown>[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(messages[2].tool_call_id).toBe("call_1");
    expect(messages[2].content).toContain("screenshot available");
    expect(messages[2].content).not.toContain(sampleImage);
    const content = messages[3].content as Record<string, unknown>[];
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64," + sampleImage } });
    expect(content[0].text).toContain("untrusted");
    const tokens = countRequestBodyTokens(JSON.stringify(req));
    expect(tokens.image).toBeGreaterThan(0);
    expect(tokens.total).toBeLessThan(2000);
  });

  it("keeps text-only tool results unchanged", () => {
    const req = { messages: [{ role: "tool", tool_call_id: "abc", content: JSON.stringify([{ type: "text", text: "just text" }]) }] };
    const original = JSON.stringify(req);
    expect(bridgeMcpToolImages(req).images).toBe(0);
    expect(JSON.stringify(req)).toBe(original);
  });

  it("does not mistake ordinary text or invalid images for valid images", () => {
    const req = sampleRequest("not base64>");
    const result = bridgeMcpToolImages(req);
    expect(result.images).toBe(0);
    expect(result.rejected).toBe(1);
    expect(JSON.stringify(req)).not.toContain("not base64>");
    expect(req.messages).toHaveLength(3);
  });

  it("converts large screenshots without charging the base64 as text tokens", () => {
    const req = sampleRequest(randomBytes(69000).toString("base64"));
    expect(countRequestBodyTokens(JSON.stringify(req)).total).toBeGreaterThan(20000);
    expect(bridgeMcpToolImages(req).images).toBe(1);
    const tokens = countRequestBodyTokens(JSON.stringify(req));
    expect(tokens.image).toBeGreaterThan(0);
    expect(tokens.total).toBeLessThan(6000);
  });

  it("keeps Playwright scale restricted to its advertised enum", () => {
    const schema = jsonSchemaToZod({ type: "object", properties: { scale: { type: "string", enum: ["css", "device"] } } });
    expect(schema.safeParse({ scale: "device" }).success).toBe(true);
    expect(schema.safeParse({ scale: "1" }).success).toBe(false);
  });
});
