import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { parseSkillFrontmatterAsync } from "../../src/skills/parser.js";

const root = path.resolve("skills/mcp-management");
const read = (relative: string): Promise<string> => fs.readFile(path.join(root, relative), "utf8");

describe("mcp-management bundled skill", () => {
  it("is model-loadable and discoverable", async () => {
    const frontmatter = await parseSkillFrontmatterAsync(path.join(root, "SKILL.md"));
    expect(frontmatter.name).toBe("mcp-management");
    expect(frontmatter.disableModelInvocation).toBe(false);
    expect(frontmatter.description).toMatch(/MCP servers/i);
  });

  it("has references for setup, Playwright, other servers and safe self-update", async () => {
    const skill = await read("SKILL.md");
    for (const page of ["configuration.md", "playwright.md", "server-examples.md", "self-update.md"]) {
      expect(skill).toContain(page);
      expect((await read("references/" + page)).length).toBeGreaterThan(500);
    }
    expect(skill).toContain("next");
    expect(skill).toContain("Do not create extra MCP-management tools");
  });

  it("contains syntactically valid, pinned server configuration examples", async () => {
    for (const page of ["playwright.md", "server-examples.md"]) {
      const text = await read("references/" + page);
      const samples = [...text.matchAll(/```json\s*([\s\S]*?)\s*```/g)];
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) {
        const parsed = JSON.parse(sample[1]) as Record<string, unknown>;
        expect(parsed.command || parsed.url).toBeTruthy();
      }
    }
  });

  it("requires explicit authorization before updating the bot itself", async () => {
    const skill = await read("SKILL.md");
    const updates = await read("references/self-update.md");
    expect(skill).toContain("explicitly requests");
    expect(updates).toMatch(/explicit user request only/i);
    expect(updates).toContain("--frozen-lockfile");
    expect(updates).toContain("systemd-run --user");
    expect(updates).toMatch(/recover|recovery|rollback/i);
  });
});
