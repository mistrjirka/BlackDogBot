import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { parseSkillFrontmatterAsync } from "../../src/skills/parser.js";

const root = path.resolve("skills/safe-self-development");

describe("safe-self-development skill", () => {
  it("loads via the normal skill mechanism", async () => {
    const parsed = await parseSkillFrontmatterAsync(path.join(root, "SKILL.md"));
    expect(parsed.name).toBe("safe-self-development");
    expect(parsed.disableModelInvocation).toBe(false);
  });
  it("documents how to choose a skill, MCP, or source code edit", async () => {
    const text = await fs.readFile(path.join(root, "SKILL.md"), "utf8");
    expect(text).toContain("Prefer an external MCP server");
    expect(text).toContain("Telegram");
    expect(text).toContain("out-of-process");
  });
  it("has detailed architecture, validation and recovery references", async () => {
    for (const name of ["architecture", "development", "deployment"]) {
      const text = await fs.readFile(path.join(root, "references", name + ".md"), "utf8");
      expect(text.length).toBeGreaterThan(600);
    }
    const guide = await fs.readFile(path.join(root, "references", "deployment.md"), "utf8");
    expect(guide).toContain("scripts/guarded-release.py");
    expect(guide).toContain("Telegram");
    expect(guide).toContain("rollback");
  });
});
