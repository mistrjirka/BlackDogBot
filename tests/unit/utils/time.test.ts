import { describe, expect, it, vi } from "vitest";

import { getCurrentTimeContext } from "../../../src/utils/time.js";

describe("time context", () => {
  it("formats request-scoped time context without putting it in system instructions", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-03T12:34:56.000Z"));

    expect(getCurrentTimeContext("UTC")).toBe(
      "<user_context>\nCurrent date and time: 2026-07-03 12:34:56 (UTC)\n</user_context>",
    );

    vi.useRealTimers();
  });
});
