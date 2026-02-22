import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { generateObject } from "ai";
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

    const result = await generateObject({
      model,
      system: SYSTEM_PROMPT,
      prompt: "Generate a JSON Schema for: An object with a title string and a count number.",
      schema: JsonSchemaZod,
    });

    const schema = result.object;
    expect(schema.type).toBe("object");
    expect(schema.properties).toBeDefined();

    const properties = schema.properties as Record<string, unknown>;
    expect(Object.keys(properties).length).toBeGreaterThanOrEqual(2);
    Object.values(properties).forEach((property) => {
      const propertyRecord = property as Record<string, unknown>;
      expect(propertyRecord.type).toBeDefined();
    });
  }, 120000);

  it("should create a valid schema for array output", async () => {
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model = aiProviderService.getDefaultModel();

    const result = await generateObject({
      model,
      system: SYSTEM_PROMPT,
      prompt: "Generate a JSON Schema for: An array of news items, each with title (string), link (string), and is_verified (boolean).",
      schema: JsonSchemaZod,
    });

    const schema = result.object;
    expect(schema.type).toBe("object");

    const properties = schema.properties as Record<string, unknown>;

    const schemaRecord = schema as unknown as Record<string, unknown>;
    const schemaItems = schemaRecord.items as Record<string, unknown> | undefined;
    const schemaItemsProperties = schemaItems?.properties as Record<string, unknown> | undefined;
    const hasArraySchemaItems =
      schemaRecord.type === "array" &&
      schemaItems?.type === "object" &&
      !!schemaItemsProperties &&
      Object.keys(schemaItemsProperties).length >= 3;

    const arrayProperty = Object.values(properties).find((property) => {
      const propertyRecord = property as Record<string, unknown>;
      if (propertyRecord.type !== "array") {
        return false;
      }
      const itemsRecord = propertyRecord.items as Record<string, unknown> | undefined;
      const itemProperties = itemsRecord?.properties as Record<string, unknown> | undefined;
      return !!itemProperties && Object.keys(itemProperties).length >= 3;
    });

    expect(hasArraySchemaItems || !!arrayProperty).toBe(true);
  }, 120000);

  it("should create schema with required fields when specified", async () => {
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model = aiProviderService.getDefaultModel();

    const result = await generateObject({
      model,
      system: SYSTEM_PROMPT,
      prompt: "Generate a JSON Schema for: An object with required 'id' string and optional 'name' string.",
      schema: JsonSchemaZod,
    });

    const schema = result.object;
    expect(schema.type).toBe("object");

    // Should have a required array
    const required = schema.required as string[] | undefined;
    expect(required).toBeDefined();
    expect(required?.length).toBeGreaterThan(0);

    const properties = schema.properties as Record<string, unknown>;
    expect(required?.length).toBeLessThan(Object.keys(properties).length);
  }, 120000);

  it("should handle complex nested schema request", async () => {
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model = aiProviderService.getDefaultModel();

    const result = await generateObject({
      model,
      system: SYSTEM_PROMPT,
      prompt: `Generate a JSON Schema for: An object containing 'items' array where each item has: 
        id (string, required), title (string, required), metadata (object with created_at string and updated_at string), 
        and tags (array of strings).`,
      schema: JsonSchemaZod,
    });

    const schema = result.object;
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.items).toBeDefined();

    const itemsSchema = properties.items as Record<string, unknown>;
    expect(itemsSchema.type).toBe("array");
    expect(itemsSchema.items).toBeDefined();

    const itemSchema = itemsSchema.items as Record<string, unknown>;
    expect(itemSchema.properties).toBeDefined();

    const itemProperties = itemSchema.properties as Record<string, unknown>;
    const nestedProperty = Object.values(itemProperties).find((property) => {
      const propertyRecord = property as Record<string, unknown>;
      return propertyRecord.type === "object" || propertyRecord.type === "array";
    });

    expect(nestedProperty).toBeDefined();
  }, 120000);
});

//#endregion Tests
