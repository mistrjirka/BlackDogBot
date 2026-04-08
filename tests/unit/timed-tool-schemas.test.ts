import { describe, it, expect } from "vitest";
import {
  addOnceToolInputSchema,
  addIntervalToolInputSchema,
  editOnceToolInputSchema,
  editIntervalToolInputSchema,
  editInstructionsToolInputSchema,
  removeTimedToolInputSchema,
} from "../../src/shared/schemas/tool-schemas.js";

describe("addOnceToolInputSchema", () => {
  it("should require name", () => {
    const result = addOnceToolInputSchema.safeParse({
      description: "Test",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      runAt: "2026-04-08T10:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("should require runAt", () => {
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test",
      instructions: "Do",
      tools: ["send_message"],
      notifyUser: true,
    });
    expect(result.success).toBe(false);
  });

  it("should accept valid once schedule", () => {
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      runAt: "2026-04-08T10:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("addIntervalToolInputSchema", () => {
  it("should require name", () => {
    const result = addIntervalToolInputSchema.safeParse({
      description: "Test",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      intervalMs: 3600000,
    });
    expect(result.success).toBe(false);
  });

  it("should require intervalMs", () => {
    const result = addIntervalToolInputSchema.safeParse({
      name: "Test",
      description: "Test",
      instructions: "Do",
      tools: ["send_message"],
      notifyUser: true,
    });
    expect(result.success).toBe(false);
  });

  it("should accept valid interval schedule", () => {
    const result = addIntervalToolInputSchema.safeParse({
      name: "Test",
      description: "Test",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      intervalMs: 3600000,
    });
    expect(result.success).toBe(true);
  });

  it("should reject zero intervalMs", () => {
    const result = addIntervalToolInputSchema.safeParse({
      name: "Test",
      description: "Test",
      instructions: "Do",
      tools: ["send_message"],
      notifyUser: true,
      intervalMs: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("removeTimedToolInputSchema", () => {
  it("should require taskId", () => {
    const result = removeTimedToolInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("should accept valid taskId", () => {
    const result = removeTimedToolInputSchema.safeParse({ taskId: "123" });
    expect(result.success).toBe(true);
  });
});
