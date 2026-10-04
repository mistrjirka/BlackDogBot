import { describe, it, expect } from "vitest";
import {
  maskToken,
  isSensitiveField,
  maskSensitiveData,
  safeStringify,
} from "../token-mask.js";

describe("maskToken", () => {
  it("should mask a long token showing first and last 4 chars", () => {
    const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const masked = maskToken(token);
    expect(masked).toBe("ghp_**************************wxyz");
    expect(masked.length).toBe(token.length);
  });

  it("should mask a very short token completely", () => {
    expect(maskToken("abc")).toBe("***");
    expect(maskToken("abcd")).toBe("****");
  });

  it("should handle empty or null values", () => {
    expect(maskToken("")).toBe("***");
    expect(maskToken(null as unknown as string)).toBe("***");
    expect(maskToken(undefined as unknown as string)).toBe("***");
  });

  it("should mask API key format", () => {
    const apiKey = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
    const masked = maskToken(apiKey);
    expect(masked).toContain("sk-p");
    expect(masked).toContain("3456");
    expect(masked).not.toContain("proj");
  });
});

describe("isSensitiveField", () => {
  it("should detect sensitive field names", () => {
    expect(isSensitiveField("apiKey")).toBe(true);
    expect(isSensitiveField("botToken")).toBe(true);
    expect(isSensitiveField("password")).toBe(true);
    expect(isSensitiveField("openrouter_api_key")).toBe(true);
    expect(isSensitiveField("jwtSecret")).toBe(true);
    expect(isSensitiveField("privateKey")).toBe(true);
  });

  it("should not flag non-sensitive fields", () => {
    expect(isSensitiveField("name")).toBe(false);
    expect(isSensitiveField("url")).toBe(false);
    expect(isSensitiveField("enabled")).toBe(false);
    expect(isSensitiveField("model")).toBe(false);
  });

  it("should handle empty or invalid input", () => {
    expect(isSensitiveField("")).toBe(false);
    expect(isSensitiveField(null as unknown as string)).toBe(false);
  });
});

describe("maskSensitiveData", () => {
  it("should mask sensitive fields in an object", () => {
    const obj = {
      apiKey: "secret-key-12345",
      model: "gpt-4",
      botToken: "bot123456:ABC-DEF",
    };
    const masked = maskSensitiveData(obj);

    expect(masked.apiKey).toBe("secr********67890");
    expect(masked.model).toBe("gpt-4");
    expect(masked.botToken).not.toBe(obj.botToken);
  });

  it("should handle nested objects", () => {
    const obj = {
      ai: {
        openrouter: {
          apiKey: "sk-or-1234567890abcdef",
        },
        model: "test-model",
      },
    };
    const masked = maskSensitiveData(obj);

    expect(masked.ai.openrouter.apiKey).not.toBe(obj.ai.openrouter.apiKey);
    expect(masked.ai.model).toBe("test-model");
  });

  it("should handle arrays", () => {
    const obj = {
      tokens: ["token123456", "token789012"],
    };
    const masked = maskSensitiveData(obj);

    expect(masked.tokens[0]).not.toBe("token123456");
    expect(masked.tokens[1]).not.toBe("token789012");
  });
});

describe("safeStringify", () => {
  it("should produce JSON with masked values", () => {
    const obj = {
      apiKey: "secret-12345",
      name: "test",
    };
    const result = safeStringify(obj);
    const parsed = JSON.parse(result);

    expect(parsed.name).toBe("test");
    expect(parsed.apiKey).not.toBe("secret-12345");
    expect(parsed.apiKey).toContain("*");
  });
});
