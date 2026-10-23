import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { parseSkillFrontmatterAsync } from "../../src/skills/parser.js";

const root = path.resolve("skills/container-maintenance");

describe("container maintenance skill", () => {
  it("loads through the skill parser without new tools", async () => {
    const skill = await parseSkillFrontmatterAsync(path.join(root, "SKILL.md"));
    expect(skill.name).toBe("container-maintenance");
    expect(skill.disableModelInvocation).toBe(false);
  });

  it("documents digest-pinned canary deployment and rollback", async () => {
    const text = await fs.readFile(path.join(root, "SKILL.md"), "utf8");
    const guide = await fs.readFile(path.join(root, "references/update-procedure.md"), "utf8");
    const script = await fs.readFile("scripts/guarded-container-update.py", "utf8");
    expect(text).toContain("rollback");
    expect(text).toContain("run_cmd");
    expect(guide).toContain("container-reports/latest.json");
    expect(guide).toContain("scrapling@sha256");
    expect(script).toContain("--no-deps");
    expect(script).toContain("rolled_back");
  });
});
