import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";

import {
  createTestEnvironment,
  resetSingletons,
  loadTestConfigAsync,
} from "../../utils/test-helpers.js";
import { SkillLoaderService } from "../../../src/services/skill-loader.service.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { markSkillSetupCompleteAsync } from "../../../src/helpers/skill-state.js";
import { createCallSkillTool } from "../../../src/tools/call-skill.tool.js";
import type { ISkill } from "../../../src/shared/types/index.js";

const env = createTestEnvironment("skill-e2e");

const SKILL_INSTRUCTIONS = `# Hello World Skill

You are a friendly greeting assistant. When the user says hello, respond with a warm greeting that includes their name if provided.

If the user asks "what is 2+2?", respond with exactly "The answer is 4."

Always be concise and helpful. Do not use any tools unless explicitly asked to run a command.`;

describe("Skill E2E", () => {
  beforeAll(async () => {
    await env.setupAsync({ logLevel: "error" });

    const configDir = path.join(env.tempDir, ".blackdogbot");
    await fs.mkdir(configDir, { recursive: true });

    await loadTestConfigAsync(env.tempDir);

    const loggerService = LoggerService.getInstance();
    await loggerService.initializeAsync("error", path.join(env.tempDir, "logs"));

    const configService = ConfigService.getInstance();
    await configService.initializeAsync();

    const promptService = PromptService.getInstance();
    await promptService.initializeAsync();

    // Create test skill on disk
    const skillDir = path.join(configDir, "skills", "hello-skill");
    await fs.mkdir(skillDir, { recursive: true });

    const skillMd = `---
name: hello-skill
description: A simple greeting skill for testing
userInvocable: true
disableModelInvocation: false
metadata:
  openclaw:
    requires:
      bins: []
      anyBins: []
      env: []
      config: []
    install: []
---

${SKILL_INSTRUCTIONS}`;

    await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMd, "utf-8");

    // Mark skill as ready
    await markSkillSetupCompleteAsync("hello-skill");
  }, 60000);

  afterAll(async () => {
    resetSingletons();
    await env.teardownAsync();
  });

  describe("skill discovery", () => {
    it("should load skills from skills directory", async () => {
      const loader = SkillLoaderService.getInstance();
      await loader.loadAllSkillsAsync();

      const allSkills = loader.getAllSkills();
      expect(allSkills.some((s) => s.name === "hello-skill")).toBe(true);
    });

    it("should include ready skills in available skills", async () => {
      const loader = SkillLoaderService.getInstance();
      await loader.loadAllSkillsAsync();

      const available = loader.getAvailableSkills();
      const helloSkill = available.find((s) => s.name === "hello-skill");
      expect(helloSkill).toBeDefined();
      expect(helloSkill!.frontmatter.description).toBe(
        "A simple greeting skill for testing"
      );
    });

    it("should return skill by name", async () => {
      const loader = SkillLoaderService.getInstance();
      const skill = loader.getSkill("hello-skill");
      expect(skill).toBeDefined();
      expect(skill!.instructions).toContain("greeting assistant");
    });

    it("should return undefined for non-existent skill", () => {
      const loader = SkillLoaderService.getInstance();
      const skill = loader.getSkill("non-existent-skill");
      expect(skill).toBeUndefined();
    });
  });

  describe("skill state", () => {
    it("should report skill as ready after setup complete", async () => {
      const loader = SkillLoaderService.getInstance();
      await loader.loadAllSkillsAsync();

      const skill = loader.getSkill("hello-skill");
      expect(skill!.state.state).toBe("ready");
    });
  });

  describe("skill invocation via tool", () => {
    it("should invoke skill through call_skill tool", async () => {
      const loader = SkillLoaderService.getInstance();
      await loader.loadAllSkillsAsync();

      const available = loader.getAvailableSkills();
      const skillNames = available.map((s) => s.name);

      const callSkillTool = createCallSkillTool(skillNames);

      const result = await callSkillTool.invoke({
        skillName: "hello-skill",
        input: "what is 2+2?",
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("4");
      expect(result.error).toBeNull();
    }, 120000);

    it("should return error for non-existent skill", async () => {
      const loader = SkillLoaderService.getInstance();
      const available = loader.getAvailableSkills();
      const skillNames = available.map((s) => s.name);

      const callSkillTool = createCallSkillTool(skillNames);

      const result = await callSkillTool.invoke({
        skillName: "non-existent-skill",
        input: "Hello!",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });

  describe("skill with requirements", () => {
    it("should detect missing binary dependencies", async () => {
      const skillDir = path.join(env.tempDir, ".blackdogbot", "skills", "deps-skill");
      await fs.mkdir(skillDir, { recursive: true });

      const skillMd = `---
name: deps-skill
description: Skill with binary requirements
userInvocable: true
disableModelInvocation: false
metadata:
  openclaw:
    requires:
      bins: ["nonexistent-binary-xyz"]
      anyBins: []
      env: []
      config: []
    install: []
---

This skill requires a binary that does not exist.`;

      await fs.writeFile(path.join(skillDir, "SKILL.md"), skillMd, "utf-8");

      const loader = SkillLoaderService.getInstance();
      await loader.loadAllSkillsAsync();

      const skill = loader.getSkill("deps-skill");
      expect(skill).toBeDefined();
      // Should not be ready since binary is missing
      expect(skill!.state.state).not.toBe("ready");
    });
  });
});