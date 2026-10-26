import { describe, expect, it } from "vitest";
import { AdminControl, type ChatSessionState } from "../../src/agent/admin-control.js";
import { makeLoggerMock } from "../utils/casts.js";

describe("human steering priority", () => {
  it("drops queued automated recommendations and aborts to process the human instruction", () => {
    const session: ChatSessionState = {
      paused: false,
      abortController: new AbortController(),
      isRunning: true,
      isSteeringAbort: false,
      steeringQueue: [
        "Duplicate-loop adviser recommendation: continue the old task",
        "Duplicate-loop adviser recommendation: retry the rejected operation",
      ],
    };
    const controller = new AdminControl(new Map([["chat", session]]), makeLoggerMock());
    expect(controller.steerChat("chat", "Give me a report")).toBe(true);
    expect(session.steeringQueue).toEqual(["Give me a report"]);
    expect(session.abortController?.signal.aborted).toBe(true);
    expect(session.isSteeringAbort).toBe(true);
  });

  it("does not queue messages when the agent is not running", () => {
    const session: ChatSessionState = {
      paused: false,
      abortController: new AbortController(),
      isRunning: false,
      isSteeringAbort: false,
      steeringQueue: [],
    };
    const controller = new AdminControl(new Map([["chat", session]]), makeLoggerMock());
    expect(controller.steerChat("chat", "New task")).toBe(false);
    expect(session.steeringQueue).toEqual([]);
  });
});
