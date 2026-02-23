import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../src/services/config.service.js";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { LoggerService } from "../../src/services/logger.service.js";
import { RateLimiterService } from "../../src/services/rate-limiter.service.js";
import { createCreateOutputSchemaTool } from "../../src/tools/create-output-schema.tool.js";

//#region Helpers

let tempDir: string;
let originalHome: string;

function resetSingletons(): void {
  (ConfigService as unknown as { _instance: null })._instance = null;
  (AiProviderService as unknown as { _instance: null })._instance = null;
  (LoggerService as unknown as { _instance: null })._instance = null;
  (RateLimiterService as unknown as { _instance: null })._instance = null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function execTool<T>(toolObj: any, args: unknown): Promise<T> {
  const result = await toolObj.execute(
    args,
    { toolCallId: "test", messages: [], abortSignal: new AbortController().signal },
  );

  return result as T;
}

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
    const toolObj = createCreateOutputSchemaTool();
    const result = await execTool<{ success: boolean; schema: Record<string, unknown> | null; error?: string }>(
      toolObj,
      { description: "An object with a title string and a count number." },
    );

    expect(result.success).toBe(true);
    const schema = result.schema as Record<string, unknown>;
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
    const toolObj = createCreateOutputSchemaTool();
    const result = await execTool<{ success: boolean; schema: Record<string, unknown> | null; error?: string }>(
      toolObj,
      { description: "An array of news items, each with title (string), link (string), and is_verified (boolean)." },
    );

    expect(result.success).toBe(true);
    const schema = result.schema as Record<string, unknown>;
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
    const toolObj = createCreateOutputSchemaTool();
    const result = await execTool<{ success: boolean; schema: Record<string, unknown> | null; error?: string }>(
      toolObj,
      { description: "An object with required 'id' string and optional 'name' string." },
    );

    expect(result.success).toBe(true);
    const schema = result.schema as Record<string, unknown>;
    expect(schema.type).toBe("object");

    // Should have a required array
    const required = schema.required as string[] | undefined;
    expect(required).toBeDefined();
    expect(required?.length).toBeGreaterThan(0);

    const properties = schema.properties as Record<string, unknown>;
    expect(required?.length).toBeGreaterThan(0);
  }, 120000);

  it("should handle complex nested schema request", async () => {
    const toolObj = createCreateOutputSchemaTool();
    const result = await execTool<{ success: boolean; schema: Record<string, unknown> | null; error?: string }>(
      toolObj,
      {
        description: "An object containing 'items' array where each item has id (string, required), title (string, required), metadata (object with created_at string and updated_at string), and tags (array of strings).",
      },
    );

    expect(result.success).toBe(true);
    const schema = result.schema as Record<string, unknown>;
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
      const propertyType = propertyRecord.type;

      if (propertyType === "object" || propertyType === "array") {
        return true;
      }

      if (Array.isArray(propertyType)) {
        return propertyType.includes("object") || propertyType.includes("array");
      }

      return false;
    });

    expect(nestedProperty).toBeDefined();
  }, 120000);
});

//#endregion Tests
