import matter from "gray-matter";
import { readFileBoundedAsync } from "../utils/bounded-file.js";
import { skillFrontmatterSchema } from "../shared/schemas/index.js";
import type { ISkillFrontmatter } from "../shared/types/index.js";

//#region Public functions

export async function parseSkillFrontmatterAsync(filePath: string): Promise<ISkillFrontmatter> {
  const raw: string = await readFileBoundedAsync(filePath);
  const parsed: matter.GrayMatterFile<string> = matter(raw);
  const result = skillFrontmatterSchema.safeParse(parsed.data);
  if (!result.success) throw new Error(`Invalid SKILL.md frontmatter in "${filePath}": ${result.error.message}`);
  return result.data;
}

export async function loadSkillInstructionsAsync(filePath: string): Promise<string> {
  const raw: string = await readFileBoundedAsync(filePath);
  return matter(raw).content;
}

//#endregion Public functions
