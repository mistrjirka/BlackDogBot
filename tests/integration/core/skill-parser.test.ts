import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { parseSkillFileAsync, type IParsedSkill } from "../../../src/skills/parser.js";

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

    const result: IParsedSkill = await parseSkillFileAsync(skillFile);

    expect(result.frontmatter.name).toBe("test-skill");
    expect(result.frontmatter.description).toBe("A test skill for unit testing");
    expect(result.frontmatter.userInvocable).toBe(true);
    expect(result.frontmatter.disableModelInvocation).toBe(false);
    expect(result.instructions).toContain("# Test Skill Instructions");
    expect(result.instructions).toContain("Do something useful.");
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

    const result: IParsedSkill = await parseSkillFileAsync(skillFile);

    expect(result.frontmatter.homepage).toBeNull();
    expect(result.frontmatter.commandDispatch).toBeNull();
    expect(result.frontmatter.commandTool).toBeNull();
    expect(result.frontmatter.commandArgMode).toBeNull();
    expect(result.frontmatter.userInvocable).toBe(true);
    expect(result.frontmatter.disableModelInvocation).toBe(false);
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

    await expect(parseSkillFileAsync(skillFile)).rejects.toThrow("Invalid SKILL.md frontmatter");
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

    await expect(parseSkillFileAsync(skillFile)).rejects.toThrow("Invalid SKILL.md frontmatter");
  });

  it("should throw when file does not exist", async () => {
    const fakePath: string = path.join(tempDir, "nonexistent.md");

    await expect(parseSkillFileAsync(fakePath)).rejects.toThrow();
  });
});

//#endregion Tests
