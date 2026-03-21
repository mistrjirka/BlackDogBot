import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { SkillLoaderService } from "../../../src/services/skill-loader.service.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import * as skillState from "../../../src/helpers/skill-state.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import type { ISkill } from "../../../src/shared/types/index.js";


let tempDir: string;
let originalHome: string;

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-skillloader-test-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;
}

async function cleanupTempHomeAsync(): Promise<void> {
  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
}


async function createSkillOnDiskAsync(dir: string, skillName: string, frontmatter: string, instructions: string): Promise<void> {
  const skillDir: string = path.join(dir, skillName);

  await fs.mkdir(skillDir, { recursive: true });

  const content: string = `---\n${frontmatter}\n---\n\n${instructions}`;

  await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf-8");
}


//#region Tests

describe("SkillLoaderService", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
    resetSingletons();

    const logger: LoggerService = LoggerService.getInstance();
    silenceLogger(logger);
  });

  afterEach(async () => {
    resetSingletons();
    vi.restoreAllMocks();
    await cleanupTempHomeAsync();
  });

  it("should load a skill from the default skills directory", async () => {
    const skillsDir: string = path.join(tempDir, ".betterclaw", "skills");

    await createSkillOnDiskAsync(skillsDir, "hello-skill", "name: hello-skill\ndescription: Hello world skill", "Say hello.");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    const skill: ISkill | undefined = service.getSkill("hello-skill");

    expect(skill).toBeDefined();
    expect(skill!.name).toBe("hello-skill");
    expect(skill!.frontmatter.description).toBe("Hello world skill");
    expect(skill!.instructions).toContain("Say hello.");
  });

  it("should load skills from additional directories", async () => {
    const additionalDir: string = path.join(tempDir, "extra-skills");

    await createSkillOnDiskAsync(additionalDir, "extra-skill", "name: extra-skill\ndescription: Extra", "Extra instructions.");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync([additionalDir]);

    const skill: ISkill | undefined = service.getSkill("extra-skill");

    expect(skill).toBeDefined();
    expect(skill!.name).toBe("extra-skill");
  });

  it("should return all loaded skills via getAllSkills", async () => {
    const skillsDir: string = path.join(tempDir, ".betterclaw", "skills");

    await createSkillOnDiskAsync(skillsDir, "skill-a", "name: skill-a\ndescription: A", "A");
    await createSkillOnDiskAsync(skillsDir, "skill-b", "name: skill-b\ndescription: B", "B");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    const all: ISkill[] = service.getAllSkills();

    expect(all).toHaveLength(2);

    const names: string[] = all.map((s: ISkill) => s.name).sort();

    expect(names).toEqual(["skill-a", "skill-b"]);
  });

  it("should return only available skills (setuped + model invocation enabled)", async () => {
    const skillsDir: string = path.join(tempDir, ".betterclaw", "skills");

    await createSkillOnDiskAsync(skillsDir, "ready-skill", "name: ready-skill\ndescription: Ready\ndisableModelInvocation: false", "Ready.");
    await createSkillOnDiskAsync(skillsDir, "disabled-skill", "name: disabled-skill\ndescription: Disabled\ndisableModelInvocation: true", "Disabled.");

    await skillState.markSkillSetupCompleteAsync("ready-skill");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    const available: ISkill[] = service.getAvailableSkills();

    expect(available).toHaveLength(1);
    expect(available[0].name).toBe("ready-skill");
  });

  it("should handle missing skills directory gracefully", async () => {
    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await expect(service.loadAllSkillsAsync()).resolves.toBeUndefined();

    const all: ISkill[] = service.getAllSkills();

    expect(all).toHaveLength(0);
  });

  it("should skip directories without SKILL.md", async () => {
    const skillsDir: string = path.join(tempDir, ".betterclaw", "skills");

    await fs.mkdir(path.join(skillsDir, "no-skill-file"), { recursive: true });

    await createSkillOnDiskAsync(skillsDir, "valid-skill", "name: valid-skill\ndescription: Valid", "Valid.");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    const all: ISkill[] = service.getAllSkills();

    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("valid-skill");
  });

  it("should skip skills with invalid frontmatter and continue loading others", async () => {
    const skillsDir: string = path.join(tempDir, ".betterclaw", "skills");

    await createSkillOnDiskAsync(skillsDir, "bad-skill", "description: No name here", "Bad.");

    await createSkillOnDiskAsync(skillsDir, "good-skill", "name: good-skill\ndescription: Good", "Good.");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    const all: ISkill[] = service.getAllSkills();

    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("good-skill");
  });

  it("should skip regular files in skills directory (not directories)", async () => {
    const skillsDir: string = path.join(tempDir, ".betterclaw", "skills");

    await fs.mkdir(skillsDir, { recursive: true });
    await fs.writeFile(path.join(skillsDir, "not-a-dir.txt"), "hello", "utf-8");

    await createSkillOnDiskAsync(skillsDir, "real-skill", "name: real-skill\ndescription: Real", "Real.");

    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    const all: ISkill[] = service.getAllSkills();

    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("real-skill");
  });

  it("should return undefined for a non-existent skill via getSkill", async () => {
    const service: SkillLoaderService = SkillLoaderService.getInstance();

    await service.loadAllSkillsAsync();

    expect(service.getSkill("does-not-exist")).toBeUndefined();
  });
});

//#endregion Tests
