import { describe, it, expect } from "vitest";
import {
  addOnceToolInputSchema,
  editOnceToolInputSchema,
} from "../../src/shared/schemas/tool-schemas.js";

describe("addOnceToolInputSchema - new split datetime fields", () => {
  it("should reject year in the past (before current year)", () => {
    const currentYear = new Date().getFullYear();
    const pastYear = currentYear - 1;
    
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test task",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      year: pastYear,
      month: 1,
      day: 1,
      hour: 12,
      minute: 0,
    });
    expect(result.success).toBe(false);
  });

  it("should accept current year", () => {
    const currentYear = new Date().getFullYear();
    
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test task",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      year: currentYear,
      month: 12,
      day: 31,
      hour: 23,
      minute: 59,
    });
    expect(result.success).toBe(true);
  });

  it("should accept year, month, day, hour, minute fields", () => {
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test task",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      year: 2026,
      month: 4,
      day: 8,
      hour: 14,
      minute: 30,
    });
    expect(result.success).toBe(true);
  });

  it("should reject invalid day for month (Feb 30)", () => {
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test task",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      year: 2026,
      month: 2,
      day: 30,
      hour: 14,
      minute: 30,
    });
    expect(result.success).toBe(false);
  });

  it("should reject invalid day for month (Apr 31)", () => {
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test task",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      year: 2026,
      month: 4,
      day: 31,
      hour: 14,
      minute: 30,
    });
    expect(result.success).toBe(false);
  });

  it("should accept valid Feb 29 for leap year", () => {
    const currentYear = new Date().getFullYear();
    const leapYear = currentYear + 1; // Next year might be a leap year, or use known leap year
    
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test task",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      year: 2028, // Known leap year
      month: 2,
      day: 29,
      hour: 14,
      minute: 30,
    });
    expect(result.success).toBe(true);
  });

  it("should reject Feb 29 for non-leap year", () => {
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test task",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      year: 2023,
      month: 2,
      day: 29,
      hour: 14,
      minute: 30,
    });
    expect(result.success).toBe(false);
  });

  it("should require all datetime fields", () => {
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test task",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      year: 2026,
      month: 4,
      // missing day, hour, minute
    });
    expect(result.success).toBe(false);
  });

  it("should reject month outside 1-12", () => {
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test task",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      year: 2026,
      month: 13,
      day: 1,
      hour: 14,
      minute: 30,
    });
    expect(result.success).toBe(false);
  });

  it("should reject hour outside 0-23", () => {
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test task",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      year: 2026,
      month: 4,
      day: 1,
      hour: 24,
      minute: 30,
    });
    expect(result.success).toBe(false);
  });

  it("should reject minute outside 0-59", () => {
    const result = addOnceToolInputSchema.safeParse({
      name: "Test",
      description: "Test task",
      instructions: "Do something",
      tools: ["send_message"],
      notifyUser: true,
      year: 2026,
      month: 4,
      day: 1,
      hour: 14,
      minute: 60,
    });
    expect(result.success).toBe(false);
  });
});

describe("editOnceToolInputSchema - new split datetime fields", () => {
  it("should accept optional datetime fields for editing", () => {
    const result = editOnceToolInputSchema.safeParse({
      taskId: "abc123",
      year: 2026,
      month: 5,
      day: 15,
      hour: 10,
      minute: 0,
    });
    expect(result.success).toBe(true);
  });

  it("should accept empty datetime fields (no update)", () => {
    const result = editOnceToolInputSchema.safeParse({
      taskId: "abc123",
      name: "New Name",
    });
    expect(result.success).toBe(true);
  });

  it("should reject invalid day when datetime fields provided", () => {
    const result = editOnceToolInputSchema.safeParse({
      taskId: "abc123",
      year: 2026,
      month: 2,
      day: 30,
      hour: 10,
      minute: 0,
    });
    expect(result.success).toBe(false);
  });
});