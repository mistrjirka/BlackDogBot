import fs from "node:fs/promises";
import matter from "gray-matter";
import { skillFrontmatterSchema } from "../shared/schemas/index.js";
import type { ISkillFrontmatter } from "../shared/types/index.js";

//#region Interfaces

export interface IParsedSkill {
  frontmatter: ISkillFrontmatter;
  instructions: string;
}

//#endregion Interfaces

//#region Public functions

export async function parseSkillFileAsync(filePath: string): Promise<IParsedSkill> {
  const raw: string = await fs.readFile(filePath, "utf-8");
  const parsed: matter.GrayMatterFile<string> = matter(raw);

  const result = skillFrontmatterSchema.safeParse(parsed.data);

  if (!result.success) {
    throw new Error(
      `Invalid SKILL.md frontmatter in "${filePath}": ${result.error.message}`,
    );
  }

  const skill: IParsedSkill = {
    frontmatter: result.data,
    instructions: parsed.content,
  };

  return skill;
}

//#endregion Public functions
