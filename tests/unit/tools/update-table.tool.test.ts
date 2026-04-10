import { describe, it, expect, beforeEach, vi } from "vitest";

import * as litesql from "../../../src/helpers/litesql.js";
import * as litesqlValidation from "../../../src/helpers/litesql-validation.js";
import { createUpdateTableTool } from "../../../src/tools/update-table.tool.js";
import { resetSingletons } from "../../utils/test-helpers.js";

vi.mock("../../../src/helpers/litesql.js");
vi.mock("../../../src/helpers/litesql-validation.js");

describe("update_table tool", () => {
  beforeEach(async () => {
    resetSingletons();
    vi.clearAllMocks();
  });

  it("converts 'now' to ISO timestamp for date-like columns", async () => {
    const tool = createUpdateTableTool("events", [
      { name: "id", type: "INTEGER", notNull: true, primaryKey: true, defaultValue: null },
      { name: "updated_at", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
      { name: "title", type: "TEXT", notNull: false, primaryKey: false, defaultValue: null },
    ]) as any;

    vi.mocked(litesqlValidation.validateTableExistsAsync).mockResolvedValue(undefined as never);
    vi.mocked(litesql.updateTableAsync).mockResolvedValue({ updatedCount: 1 } as never);

    const result = await tool.execute({
      where: "id = 1",
      updated_at: "now",
      title: "patched",
    });

    expect(result.success).toBe(true);
    expect(litesql.updateTableAsync).toHaveBeenCalledTimes(1);

    const setArg = vi.mocked(litesql.updateTableAsync).mock.calls[0][2] as Record<string, unknown>;
    expect(typeof setArg.updated_at).toBe("string");
    expect((setArg.updated_at as string)).toContain("T");
    expect(setArg.updated_at).not.toBe("now");
    expect(setArg.title).toBe("patched");
  });
});
