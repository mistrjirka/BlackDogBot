import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { RateLimiterService } from "../../../src/services/rate-limiter.service.js";
import { createCreateOutputSchemaTool } from "../../../src/tools/create-output-schema.tool.js";

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
    const result = await execTool<{
      success: boolean;
      blueprint: Record<string, unknown> | null;
      schema: Record<string, unknown> | null;
      error?: string;
    }>(
      toolObj,
      { description: "An object with a title string and a count number." },
    );

    expect(result.success).toBe(true);
    const blueprint = result.blueprint as Record<string, unknown>;
    const schema = result.schema as Record<string, unknown>;
    expect(blueprint.type).toBe("object");
    expect(Array.isArray(blueprint.fields)).toBe(true);
    expect((blueprint.fields as unknown[]).length).toBeGreaterThanOrEqual(2);
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
    const result = await execTool<{
      success: boolean;
      blueprint: Record<string, unknown> | null;
      schema: Record<string, unknown> | null;
      error?: string;
    }>(
      toolObj,
      { description: "An array of news items, each with title (string), link (string), and is_verified (boolean)." },
    );

    expect(result.success).toBe(true);
    const blueprint = result.blueprint as Record<string, unknown>;
    const schema = result.schema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    expect(blueprint.type).toBe("array");

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

  it("should produce non-empty blueprint fields", async () => {
    const toolObj = createCreateOutputSchemaTool();
    const result = await execTool<{
      success: boolean;
      blueprint: Record<string, unknown> | null;
      schema: Record<string, unknown> | null;
      error?: string;
    }>(
      toolObj,
      { description: "An object with required 'id' string and optional 'name' string." },
    );

    expect(result.success).toBe(true);
    const blueprint = result.blueprint as Record<string, unknown>;
    const fields = blueprint.fields as Array<Record<string, unknown>>;
    expect(Array.isArray(fields)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
    for (const field of fields) {
      expect(typeof field.name).toBe("string");
      expect(field.name).not.toBe("");
      expect(["string", "number", "boolean", "stringArray", "numberArray"]).toContain(field.type);
    }
  }, 120000);

  it("should map array field types to array item schemas", async () => {
    const toolObj = createCreateOutputSchemaTool();
    const result = await execTool<{
      success: boolean;
      blueprint: Record<string, unknown> | null;
      schema: Record<string, unknown> | null;
      error?: string;
    }>(
      toolObj,
      {
        description: "An object containing titles as string array and scores as number array.",
      },
    );

    expect(result.success).toBe(true);
    const schema = result.schema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    const arrayProperty = Object.values(properties).find((property) => {
      const propertyRecord = property as Record<string, unknown>;
      return propertyRecord.type === "array";
    }) as Record<string, unknown> | undefined;
    expect(arrayProperty).toBeDefined();
    expect(arrayProperty?.items).toBeDefined();
  }, 120000);
});

//#endregion Tests
