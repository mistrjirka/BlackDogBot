import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateText } from "ai";
import { z } from "zod";

import { ConfigService } from "../../src/services/config.service.js";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (ConfigService as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
}

// Zod schema for JSON Schema output - matches the tool's schema
const JsonSchemaZod = z.object({
  type: z.literal("object"),
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).optional(),
});

const SYSTEM_PROMPT: string = `You are a JSON Schema expert. Your ONLY job is to generate valid JSON Schemas based on user descriptions.

## Rules
1. Always use "type": "object" as the root
2. Always include a "properties" object
3. Use these types only: "string", "number", "integer", "boolean", "array", "object", "null"
4. For arrays, always include "items" describing what's in the array
5. Mark required fields in a "required" array at the root level
6. Add "description" fields for clarity - these help LLMs understand fields`;

//#endregion Helpers

//#region Tests

describe("create_output_schema tool (e2e)", () => {
  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-schema-e2e-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    // Copy real config to temp HOME
    const realConfigPath: string = path.join(originalHome, ".betterclaw", "config.yaml");
    const tempConfigDir: string = path.join(tempDir, ".betterclaw");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    // Initialize services
    const loggerService: LoggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    const configService: ConfigService = ConfigService.getInstance();
    await configService.initializeAsync(tempConfigPath);

    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    aiProviderService.initialize(configService.getConfig().ai);
  });

  afterAll(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("should create a valid schema for simple object output", async () => {
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model = aiProviderService.getDefaultModel();

    // Use generateText for broader model compatibility (no json_schema required)
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: "Generate a JSON Schema for: An object with a title string and a count number. Return ONLY the JSON schema, no markdown.",
    });

    // Parse and validate the response
    const text: string = result.text.trim();
    let parsed: unknown;
    
    try {
      // Try to extract JSON from markdown code blocks if present
      let jsonText: string = text;
      const jsonMatch: RegExpMatchArray | null = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch && jsonMatch[1]) {
        jsonText = jsonMatch[1].trim();
      }
      parsed = JSON.parse(jsonText);
    } catch {
      // If parsing fails, the test should fail
      expect.fail(`Failed to parse LLM response as JSON: ${text}`);
    }

    const validationResult = JsonSchemaZod.safeParse(parsed);
    expect(validationResult.success).toBe(true);
    
    if (validationResult.success) {
      expect(validationResult.data.type).toBe("object");
      expect(validationResult.data.properties).toBeDefined();
    }
  }, 60000);

  it("should create a valid schema for array output", async () => {
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model = aiProviderService.getDefaultModel();

    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: "Generate a JSON Schema for: An array of news items, each with title (string), link (string), and is_verified (boolean). Return ONLY the JSON schema, no markdown.",
    });

    const text: string = result.text.trim();
    let parsed: unknown;
    
    try {
      let jsonText: string = text;
      const jsonMatch: RegExpMatchArray | null = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch && jsonMatch[1]) {
        jsonText = jsonMatch[1].trim();
      }
      parsed = JSON.parse(jsonText);
    } catch {
      expect.fail(`Failed to parse LLM response as JSON: ${text}`);
    }

    const validationResult = JsonSchemaZod.safeParse(parsed);
    expect(validationResult.success).toBe(true);

    if (validationResult.success) {
      expect(validationResult.data.type).toBe("object");

      // Should have an array property
      const properties = validationResult.data.properties as Record<string, unknown>;
      const arrayKey = Object.keys(properties).find(
        (key) => (properties[key] as Record<string, unknown>)?.type === "array",
      );
      expect(arrayKey).toBeDefined();

      // Array should have items defined
      const arrayProperty = properties[arrayKey!] as Record<string, unknown>;
      expect(arrayProperty.items).toBeDefined();
    }
  }, 60000);

  it("should create schema with required fields when specified", async () => {
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model = aiProviderService.getDefaultModel();

    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: "Generate a JSON Schema for: An object with required 'id' string and optional 'name' string. Return ONLY the JSON schema, no markdown.",
    });

    const text: string = result.text.trim();
    let parsed: unknown;
    
    try {
      let jsonText: string = text;
      const jsonMatch: RegExpMatchArray | null = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch && jsonMatch[1]) {
        jsonText = jsonMatch[1].trim();
      }
      parsed = JSON.parse(jsonText);
    } catch {
      expect.fail(`Failed to parse LLM response as JSON: ${text}`);
    }

    const validationResult = JsonSchemaZod.safeParse(parsed);
    expect(validationResult.success).toBe(true);

    if (validationResult.success) {
      // Should have a required array
      const required = validationResult.data.required as string[] | undefined;
      expect(required).toBeDefined();
      expect(required).toContain("id");
    }
  }, 60000);

  it("should handle complex nested schema request", async () => {
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model = aiProviderService.getDefaultModel();

    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: `Generate a JSON Schema for: An object containing 'items' array where each item has: 
        id (string, required), title (string, required), metadata (object with created_at string and updated_at string), 
        and tags (array of strings). Return ONLY the JSON schema, no markdown.`,
    });

    const text: string = result.text.trim();
    let parsed: unknown;
    
    try {
      let jsonText: string = text;
      const jsonMatch: RegExpMatchArray | null = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch && jsonMatch[1]) {
        jsonText = jsonMatch[1].trim();
      }
      parsed = JSON.parse(jsonText);
    } catch {
      expect.fail(`Failed to parse LLM response as JSON: ${text}`);
    }

    const validationResult = JsonSchemaZod.safeParse(parsed);
    expect(validationResult.success).toBe(true);

    if (validationResult.success) {
      const properties = validationResult.data.properties as Record<string, unknown>;
      expect(properties.items).toBeDefined();

      const itemsSchema = properties.items as Record<string, unknown>;
      expect(itemsSchema.type).toBe("array");
      expect(itemsSchema.items).toBeDefined();

      const itemSchema = itemsSchema.items as Record<string, unknown>;
      expect(itemSchema.properties).toBeDefined();

      const itemProperties = itemSchema.properties as Record<string, unknown>;
      expect(itemProperties.id).toBeDefined();
      expect(itemProperties.title).toBeDefined();
      expect(itemProperties.metadata).toBeDefined();
      expect(itemProperties.tags).toBeDefined();
    }
  }, 60000);
});

//#endregion Tests
