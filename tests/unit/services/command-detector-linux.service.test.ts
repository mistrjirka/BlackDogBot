import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CommandDetectorLinuxService } from "../../../src/services/command-detector-linux.service.js";

describe("CommandDetectorLinuxService", () => {
  let service: CommandDetectorLinuxService;

  beforeEach(() => {
    service = CommandDetectorLinuxService.getInstance();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await service.stopAllAsync();
  });

  describe("_isStdinBlocked - strace parser", () => {
    it("detects unfinished read(0, ...)", () => {
      const line = 'read(0, "input data", 1024) <unfinished ...>';
      const result = (service as any)._isStdinBlocked(line);
      expect(result).toBe(true);
    });

    it("detects poll/ppoll with fd=0", () => {
      const line = 'poll([{fd=0, events=POLLIN}], 1, 100) = 1 (left 99)';
      const result = (service as any)._isStdinBlocked(line);
      expect(result).toBe(true);
    });

    it("detects select/pselect with fd=0", () => {
      const line = 'select(1, [0], NULL, NULL, {tv_sec=0, tv_usec=100000}) = 0 (Timeout)';
      const result = (service as any)._isStdinBlocked(line);
      expect(result).toBe(true);
    });

    it("detects read(0, ...) with EAGAIN", () => {
      const line = 'read(0, "", 1024) = -1 EAGAIN (Resource temporarily unavailable)';
      const result = (service as any)._isStdinBlocked(line);
      expect(result).toBe(true);
    });

    it("does NOT trigger on read(1, ...)", () => {
      const line = 'read(1, "output", 1024) <unfinished ...>';
      const result = (service as any)._isStdinBlocked(line);
      expect(result).toBe(false);
    });

    it("does NOT trigger on read(2, ...)", () => {
      const line = 'read(2, "error", 1024) <unfinished ...>';
      const result = (service as any)._isStdinBlocked(line);
      expect(result).toBe(false);
    });

    it("does NOT trigger on poll without fd=0", () => {
      const line = 'poll([{fd=3, events=POLLIN}], 1, 100) = 1 (left 99)';
      const result = (service as any)._isStdinBlocked(line);
      expect(result).toBe(false);
    });
  });

  describe("startAsync - strace not found", () => {
    it("returns available=false when strace not found", async () => {
      vi.spyOn(require("child_process"), "execSync").mockImplementation(() => {
        throw new Error("Command not found");
      });

      vi.spyOn(require("node:fs"), "readFileSync").mockReturnValue("0\n");

      const callback = vi.fn();
      const result = await service.startAsync(12345, callback);

      expect(result.available).toBe(false);
      expect(result.error).toContain("strace not found");
    });
  });
});
