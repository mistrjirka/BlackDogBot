import { describe, expect, it } from "vitest";

import { TOOL_PREREQUISITES } from "../../../src/shared/schemas/tool-schemas.js";
import { runTimedTool } from "../../../src/tools/run-timed.tool.js";

describe("run_timed prerequisites", () => {
  it("registers get_timed as a prerequisite in schema registry", () => {
    expect(TOOL_PREREQUISITES.run_timed).toEqual([
      { tool: "get_timed", args: { taskId: "TASK_ID_PLACEHOLDER" } },
    ]);
  });

  it("documents get_timed pre-check in tool description", () => {
    expect(runTimedTool.description).toContain("MUST call 'get_timed' first");
    expect(runTimedTool.description).toContain("pre-check is enforced");
  });
});
