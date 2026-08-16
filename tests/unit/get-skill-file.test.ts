import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionOptions } from "ai";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SkillLoaderService } from "../../src/services/skill-loader.service.js";
import type { ISkill } from "../../src/shared/types/index.js";
import { getSkillFileTool } from "../../src/tools/get-skill-file.tool.js";

const toolOptions: ToolExecutionOptions = { toolCallId: "test", messages: [] };

function createReadySkill(directory: string): ISkill {
  return {
    name: "fixture",
    frontmatter: { name: "fixture", description: "fixture", homepage: null, userInvocable: true, disableModelInvocation: false, commandDispatch: null, commandTool: null, commandArgMode: null, metadata: { openclaw: null } },
    directory,
    skillFilePath: path.join(directory, "SKILL.md"),
    stateScope: null,
    state: { state: "ready", lastError: null, setupAt: null, lastCheckedAt: null, missingDeps: null, manualStepsRequired: [], attemptedInstalls: [], setupFingerprint: null, setupAttempts: 0, nextSetupAttemptAt: null },
    autoSetupAllowed: true,
  };
}

let tempDir: string | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir !== null) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("get_skill_file", () => {
  it("reads resources from the loaded skill directory", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-skill-file-test-"));
    const resourcePath = path.join(tempDir, "references", "guide.md");
    await fs.mkdir(path.dirname(resourcePath), { recursive: true });
    await fs.writeFile(resourcePath, "reference content", "utf-8");

    vi.spyOn(SkillLoaderService.getInstance(), "getAvailableSkill").mockReturnValue(createReadySkill(tempDir));

    if (!getSkillFileTool.execute) {
      throw new Error("get_skill_file has no execute function");
    }
    const result = await getSkillFileTool.execute(
      { skillName: "fixture", filePath: "references/guide.md" },
      toolOptions,
    );

    expect(result).toEqual({ content: "reference content", exists: true });
  });

  it("blocks paths outside the loaded skill directory", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-skill-file-test-"));
    vi.spyOn(SkillLoaderService.getInstance(), "getAvailableSkill").mockReturnValue(createReadySkill(tempDir));

    if (!getSkillFileTool.execute) {
      throw new Error("get_skill_file has no execute function");
    }
    const result = await getSkillFileTool.execute(
      { skillName: "fixture", filePath: "../outside.txt" },
      toolOptions,
    );

    expect(result).toEqual({ content: "", exists: false });
  });

  it("rejects a skill directory redirected after catalog loading", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-skill-file-test-"));
    const skillDir = path.join(tempDir, "skill");
    await fs.mkdir(skillDir);
    await fs.writeFile(path.join(tempDir, "secret.txt"), "secret", "utf-8");
    vi.spyOn(SkillLoaderService.getInstance(), "getAvailableSkill").mockReturnValue(createReadySkill(skillDir));
    await fs.rm(skillDir, { recursive: true });
    await fs.symlink(tempDir, skillDir, "dir");

    if (!getSkillFileTool.execute) {
      throw new Error("get_skill_file has no execute function");
    }
    const result = await getSkillFileTool.execute(
      { skillName: "fixture", filePath: "secret.txt" },
      toolOptions,
    );

    expect(result).toEqual({ content: "", exists: false });
  });
});
