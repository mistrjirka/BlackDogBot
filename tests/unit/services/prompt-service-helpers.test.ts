import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  fileExistsAsync,
  listFilesRecursiveAsync,
  resolvePromptIncludesAsync,
} from "../../../src/services/prompt-service-helpers.js";

describe("prompt-service-helpers", () => {
  const tempDir: string = path.join(os.tmpdir(), `prompt-service-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("fileExistsAsync", () => {
    it("returns true for existing file", async () => {
      const testFile: string = path.join(tempDir, "exists.txt");
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(testFile, "test content");

      const result: boolean = await fileExistsAsync(testFile);
      expect(result).toBe(true);
    });

    it("returns false for non-existing file", async () => {
      const result: boolean = await fileExistsAsync(path.join(tempDir, "does-not-exist.txt"));
      expect(result).toBe(false);
    });

    it("returns true for accessible directory path", async () => {
      await fs.mkdir(tempDir, { recursive: true });
      const result: boolean = await fileExistsAsync(tempDir);
      expect(result).toBe(true); // directories can be accessed
    });
  });

  describe("listFilesRecursiveAsync", () => {
    it("returns nested files", async () => {
      await fs.mkdir(path.join(tempDir, "level1", "level2"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "root.txt"), "root");
      await fs.writeFile(path.join(tempDir, "level1", "level1.txt"), "level1");
      await fs.writeFile(path.join(tempDir, "level1", "level2", "level2.txt"), "level2");

      const files: string[] = await listFilesRecursiveAsync(tempDir);

      expect(files).toHaveLength(3);
      expect(files.some((f: string): boolean => f.endsWith("root.txt"))).toBe(true);
      expect(files.some((f: string): boolean => f.endsWith("level1.txt"))).toBe(true);
      expect(files.some((f: string): boolean => f.endsWith("level2.txt"))).toBe(true);
    });

    it("returns empty array for empty directory", async () => {
      await fs.mkdir(tempDir, { recursive: true });

      const files: string[] = await listFilesRecursiveAsync(tempDir);
      expect(files).toHaveLength(0);
    });
  });

  describe("resolvePromptIncludesAsync", () => {
    it("resolves include directives recursively", async () => {
      await fs.mkdir(path.join(tempDir, "prompts"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "prompts", "base.txt"), "Base {{include:header.txt}} content");
      await fs.writeFile(path.join(tempDir, "prompts", "header.txt"), "Header content");

      const content: string = await fs.readFile(path.join(tempDir, "prompts", "base.txt"), "utf-8");
      const result: string = await resolvePromptIncludesAsync(content, path.join(tempDir, "prompts"), 3);

      expect(result).toBe("Base Header content content");
    });

    it("throws when include file is missing", async () => {
      await fs.mkdir(path.join(tempDir, "prompts"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "prompts", "missing.txt"), "Content {{include:nonexistent.txt}} here");

      const content: string = await fs.readFile(path.join(tempDir, "prompts", "missing.txt"), "utf-8");

      await expect(
        resolvePromptIncludesAsync(content, path.join(tempDir, "prompts"), 3),
      ).rejects.toThrow(/nonexistent\.txt/);
    });

    it("respects max depth and returns unresolved content when depth exceeded", async () => {
      await fs.mkdir(path.join(tempDir, "prompts"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "prompts", "depth.txt"),
        "Level {{include:nested.txt}}",
      );
      await fs.writeFile(
        path.join(tempDir, "prompts", "nested.txt"),
        "Nested {{include:deeper.txt}}",
      );
      await fs.writeFile(
        path.join(tempDir, "prompts", "deeper.txt"),
        "Deeper content",
      );

      const content: string = await fs.readFile(path.join(tempDir, "prompts", "depth.txt"), "utf-8");
      const maxDepth: number = 1;

      const result: string = await resolvePromptIncludesAsync(content, path.join(tempDir, "prompts"), maxDepth);

      expect(result).toBe("Level Nested {{include:deeper.txt}}");
      expect(result).not.toContain("Deeper content");
    });

    it("handles multiple includes in same file", async () => {
      await fs.mkdir(path.join(tempDir, "prompts"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "prompts", "a.txt"), "File A");
      await fs.writeFile(path.join(tempDir, "prompts", "b.txt"), "File B");
      await fs.writeFile(
        path.join(tempDir, "prompts", "combined.txt"),
        "Start {{include:a.txt}} middle {{include:b.txt}} end",
      );

      const content: string = await fs.readFile(path.join(tempDir, "prompts", "combined.txt"), "utf-8");
      const result: string = await resolvePromptIncludesAsync(content, path.join(tempDir, "prompts"), 3);

      expect(result).toBe("Start File A middle File B end");
    });

    it("returns content unchanged when no includes present", async () => {
      await fs.mkdir(path.join(tempDir, "prompts"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "prompts", "no-includes.txt"), "Plain content without includes");

      const content: string = await fs.readFile(path.join(tempDir, "prompts", "no-includes.txt"), "utf-8");
      const result: string = await resolvePromptIncludesAsync(content, path.join(tempDir, "prompts"), 3);

      expect(result).toBe("Plain content without includes");
    });
  });
});
