import { afterEach, describe, expect, it, vi } from "vitest";

describe("environment-configured limits", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reads tool-output limits from environment variables", async () => {
    vi.stubEnv("BLACKDOGBOT_CAPTURE_THRESHOLD_CHARS", "5000");
    vi.stubEnv("BLACKDOGBOT_PREVIEW_MAX_CHARS", "1500");
    vi.stubEnv("BLACKDOGBOT_INSPECT_VARIABLE_MAX_CHARS", "30000");
    vi.stubEnv("BLACKDOGBOT_INSPECT_VARIABLE_DEFAULT_CHARS", "6000");
    vi.stubEnv("BLACKDOGBOT_READ_DB_DEFAULT_LIMIT", "35");
    vi.resetModules();

    const limits = await import("../../src/shared/limits.js");

    expect(limits.CAPTURE_THRESHOLD_CHARS).toBe(5000);
    expect(limits.PREVIEW_MAX_CHARS).toBe(1500);
    expect(limits.INSPECT_VARIABLE_MAX_CHARS).toBe(30000);
    expect(limits.INSPECT_VARIABLE_DEFAULT_CHARS).toBe(6000);
    expect(limits.READ_DB_DEFAULT_LIMIT).toBe(35);
  });

  it("clamps invalid or out-of-range values", async () => {
    vi.stubEnv("BLACKDOGBOT_CAPTURE_THRESHOLD_CHARS", "10");
    vi.stubEnv("BLACKDOGBOT_PREVIEW_MAX_CHARS", "999999");
    vi.stubEnv("BLACKDOGBOT_INSPECT_VARIABLE_DEFAULT_CHARS", "999999");
    vi.stubEnv("BLACKDOGBOT_READ_DB_DEFAULT_LIMIT", "999");
    vi.resetModules();

    const limits = await import("../../src/shared/limits.js");

    expect(limits.CAPTURE_THRESHOLD_CHARS).toBe(500);
    expect(limits.PREVIEW_MAX_CHARS).toBe(50_000);
    expect(limits.INSPECT_VARIABLE_DEFAULT_CHARS).toBe(limits.INSPECT_VARIABLE_MAX_CHARS);
    expect(limits.READ_DB_DEFAULT_LIMIT).toBe(50);
  });
});
