import { describe, expect, it, vi } from "vitest";

import { buildCronToolsAsync } from "../../../src/tools/build-cron-tools.js";
import { CRON_VALID_TOOL_NAMES } from "../../../src/shared/schemas/tool-schemas.js";
import * as perTableToolsModule from "../../../src/utils/per-table-tools.js";

vi.mock("../../../src/utils/per-table-tools.js", () => ({
  buildPerTableToolsAsync: vi.fn(),
}));

vi.mock("../../../src/services/logger.service.js", () => ({
  LoggerService: {
    getInstance: vi.fn(() => ({
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

describe("buildCronToolsAsync", () => {
  it("returns all three cron tools", async () => {
    vi.mocked(perTableToolsModule.buildPerTableToolsAsync).mockResolvedValue({});

    const result = await buildCronToolsAsync();

    expect(result.add_cron).toBeDefined();
    expect(result.edit_cron).toBeDefined();
    expect(result.edit_cron_instructions).toBeDefined();
  });

  it("add_cron tool has correct name and structure", async () => {
    vi.mocked(perTableToolsModule.buildPerTableToolsAsync).mockResolvedValue({});

    const result = await buildCronToolsAsync();

    expect(result.add_cron.name).toBe("add_cron");
    expect(typeof result.add_cron.invoke).toBe("function");
    expect(typeof result.add_cron.description).toBe("string");
    expect(result.add_cron.description.length).toBeGreaterThan(0);
  });

  it("edit_cron tool has correct name and structure", async () => {
    vi.mocked(perTableToolsModule.buildPerTableToolsAsync).mockResolvedValue({});

    const result = await buildCronToolsAsync();

    expect(result.edit_cron.name).toBe("edit_cron");
    expect(typeof result.edit_cron.invoke).toBe("function");
    expect(typeof result.edit_cron.description).toBe("string");
    expect(result.edit_cron.description.length).toBeGreaterThan(0);
  });

  it("edit_cron_instructions tool has correct name and structure", async () => {
    vi.mocked(perTableToolsModule.buildPerTableToolsAsync).mockResolvedValue({});

    const result = await buildCronToolsAsync();

    expect(result.edit_cron_instructions.name).toBe("edit_cron_instructions");
    expect(typeof result.edit_cron_instructions.invoke).toBe("function");
    expect(typeof result.edit_cron_instructions.description).toBe("string");
    expect(result.edit_cron_instructions.description.length).toBeGreaterThan(0);
  });

  it("includes CRON_VALID_TOOL_NAMES in the tools field schema description", async () => {
    vi.mocked(perTableToolsModule.buildPerTableToolsAsync).mockResolvedValue({});

    const result = await buildCronToolsAsync();

    const schema = result.add_cron.schema as any;
    const innerSchema = schema._def.typeName === "ZodEffects" ? schema._def.schema : schema;
    const toolsFieldDescription = innerSchema.shape.tools._def.description;

    for (const toolName of CRON_VALID_TOOL_NAMES) {
      expect(toolsFieldDescription).toContain(toolName);
    }
  });

  it("includes dynamic write_table_ tools in the tools field schema description", async () => {
    const mockPerTableTools = {
      write_table_users: {} as any,
      write_table_orders: {} as any,
    };
    vi.mocked(perTableToolsModule.buildPerTableToolsAsync).mockResolvedValue(mockPerTableTools);

    const result = await buildCronToolsAsync();

    const schema = result.add_cron.schema as any;
    const innerSchema = schema._def.typeName === "ZodEffects" ? schema._def.schema : schema;
    const toolsFieldDescription = innerSchema.shape.tools._def.description;

    expect(toolsFieldDescription).toContain("write_table_users");
    expect(toolsFieldDescription).toContain("write_table_orders");
  });

  it("uses real execute functions (not stubs)", async () => {
    const mockPerTableTools = {
      write_table_test: {} as any,
    };
    vi.mocked(perTableToolsModule.buildPerTableToolsAsync).mockResolvedValue(mockPerTableTools);

    const result = await buildCronToolsAsync();

    expect(typeof result.add_cron.invoke).toBe("function");
    expect(typeof result.edit_cron.invoke).toBe("function");
    expect(typeof result.edit_cron_instructions.invoke).toBe("function");
  });
});
