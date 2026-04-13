import { describe, it, expect } from "vitest";
import { CRON_TOOL_DESCRIPTIONS } from "../../../src/shared/constants/cron-descriptions.js";

describe("search_timed integration registration", () => {
  it("should have CRON_TOOL_DESCRIPTIONS entry for search_timed", () => {
    expect(CRON_TOOL_DESCRIPTIONS).toHaveProperty("search_timed");
  });

  it("should mention scheduled tasks in search_timed description", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS.search_timed.toLowerCase();
    expect(description).toMatch(/scheduled|task/i);
  });

  it("should mention search in search_timed description", () => {
    const description: string = CRON_TOOL_DESCRIPTIONS.search_timed.toLowerCase();
    expect(description).toMatch(/search/i);
  });
});
