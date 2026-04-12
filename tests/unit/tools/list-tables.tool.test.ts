import { beforeEach, describe, expect, it, vi } from "vitest";

import * as litesql from "../../../src/helpers/litesql.js";
import { listTablesTool } from "../../../src/tools/list-tables.tool.js";
import { resetSingletons } from "../../utils/test-helpers.js";

vi.mock("../../../src/helpers/litesql.js");

describe("list_tables tool", () => {
  beforeEach(async () => {
    resetSingletons();
    vi.clearAllMocks();
  });

  it("lists tables from the internal database without databaseName in output", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(true);
    vi.mocked(litesql.listTablesAsync).mockResolvedValue(["daily_status", "better_claw_state"]);

    const result = await (listTablesTool as any).execute({});

    expect(result.tables).toEqual(["daily_status", "better_claw_state"]);
    expect(result).not.toHaveProperty("databaseName");
    expect(litesql.databaseExistsAsync).toHaveBeenCalledWith("blackdog");
    expect(litesql.listTablesAsync).toHaveBeenCalledWith("blackdog");
  });

  it("returns non-enumerating error when internal database is missing", async () => {
    vi.mocked(litesql.databaseExistsAsync).mockResolvedValue(false);

    const result = await (listTablesTool as any).execute({});

    expect(result.tables).toEqual([]);
    expect(result.error).toBe("Internal database is not initialized.");
    expect(result.error).not.toContain("Available databases");
  });
});
