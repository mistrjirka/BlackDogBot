import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { loadSkillInstructionsAsync, parseSkillFrontmatterAsync } from "../../../src/skills/parser.js";

//#region Helpers

let tempDir: string;

async function setupTempDirAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-parser-test-"));
}

async function cleanupTempDirAsync(): Promise<void> {
  await fs.rm(tempDir, { recursive: true, force: true });
}

//#endregion Helpers

//#region Tests

describe("skill parser", () => {
  beforeEach(async () => {
    await setupTempDirAsync();
  });

  afterEach(async () => {
    await cleanupTempDirAsync();
  });

  it("should parse a valid SKILL.md file with frontmatter and instructions", async () => {
    const skillFile: string = path.join(tempDir, "SKILL.md");
    const content: string = [
      "---",
      "name: test-skill",
      "description: A test skill for unit testing",
      "userInvocable: true",
      "disableModelInvocation: false",
      "---",
      "",
      "# Test Skill Instructions",
      "",
      "Do something useful.",
    ].join("\n");

    await fs.writeFile(skillFile, content, "utf-8");

    const frontmatter = await parseSkillFrontmatterAsync(skillFile);
    const instructions: string = await loadSkillInstructionsAsync(skillFile);

    expect(frontmatter.name).toBe("test-skill");
    expect(frontmatter.description).toBe("A test skill for unit testing");
    expect(frontmatter.userInvocable).toBe(true);
    expect(frontmatter.disableModelInvocation).toBe(false);
    expect(instructions).toContain("# Test Skill Instructions");
    expect(instructions).toContain("Do something useful.");
  });

  it("should apply defaults for optional frontmatter fields", async () => {
    const skillFile: string = path.join(tempDir, "SKILL.md");
    const content: string = [
      "---",
      "name: minimal-skill",
      "description: Minimal",
      "---",
      "",
      "Instructions here.",
    ].join("\n");

    await fs.writeFile(skillFile, content, "utf-8");

    const frontmatter = await parseSkillFrontmatterAsync(skillFile);

    expect(frontmatter.homepage).toBeNull();
    expect(frontmatter.commandDispatch).toBeNull();
    expect(frontmatter.commandTool).toBeNull();
    expect(frontmatter.commandArgMode).toBeNull();
    expect(frontmatter.userInvocable).toBe(true);
    expect(frontmatter.disableModelInvocation).toBe(false);
  });

  it("should throw on invalid frontmatter (missing required name)", async () => {
    const skillFile: string = path.join(tempDir, "SKILL.md");
    const content: string = [
      "---",
      "description: No name provided",
      "---",
      "",
      "Instructions.",
    ].join("\n");

    await fs.writeFile(skillFile, content, "utf-8");

    await expect(parseSkillFrontmatterAsync(skillFile)).rejects.toThrow("Invalid SKILL.md frontmatter");
  });

  it("should throw on invalid skill name format (uppercase not allowed)", async () => {
    const skillFile: string = path.join(tempDir, "SKILL.md");
    const content: string = [
      "---",
      "name: InvalidName",
      "description: Bad name format",
      "---",
      "",
      "Instructions.",
    ].join("\n");

    await fs.writeFile(skillFile, content, "utf-8");

    await expect(parseSkillFrontmatterAsync(skillFile)).rejects.toThrow("Invalid SKILL.md frontmatter");
  });

  it("should reject oversized instruction files", async () => {
    const skillFile: string = path.join(tempDir, "SKILL.md");
    const content: string = `---\nname: large-skill\ndescription: Large\n---\n\n${"x".repeat(1024 * 1024)}`;

    await fs.writeFile(skillFile, content, "utf-8");

    await expect(loadSkillInstructionsAsync(skillFile)).rejects.toThrow("exceeds");
  });

  it("should throw when file does not exist", async () => {
    const fakePath: string = path.join(tempDir, "nonexistent.md");

    await expect(parseSkillFrontmatterAsync(fakePath)).rejects.toThrow();
  });
});

//#endregion Tests
