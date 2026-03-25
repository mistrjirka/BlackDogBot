import { tool } from "langchain";

import { callSkillToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { LoggerService } from "../services/logger.service.js";
import { ConfigService } from "../services/config.service.js";
import { createChatModel } from "../services/langchain-model.service.js";
import { thinkTool } from "./think.tool.js";
import { runCmdTool } from "./run-cmd.tool.js";
import { searchKnowledgeTool } from "./search-knowledge.tool.js";
import { addKnowledgeTool } from "./add-knowledge.tool.js";
import type { ISkill } from "../shared/types/index.js";
import { createDeepAgent } from "deepagents";

interface ICallSkillResult {
  success: boolean;
  output: string;
  error: string | null;
}

export function createCallSkillTool(availableSkillNames: string[]) {
  const skillListStr: string = availableSkillNames.length > 0
    ? `Available skills: ${availableSkillNames.join(", ")}.`
    : "No skills are currently loaded.";

  return tool(
    async ({ skillName, input }: { skillName: string; input: string }): Promise<ICallSkillResult> => {
      const logger: LoggerService = LoggerService.getInstance();

      try {
        const skill: ISkill | undefined = SkillLoaderService.getInstance().getSkill(skillName);

        if (!skill) {
          const loaded = SkillLoaderService.getInstance().getAvailableSkills();
          const names = loaded.map((s) => s.name).join(", ") || "(none)";
          return {
            success: false,
            output: "",
            error: `Skill "${skillName}" not found. Currently loaded skills: ${names}. Web search is available via the searxng tool (and crawl4ai for page fetching), not as a skill.`,
          };
        }

        if (skill.state.state !== "ready") {
          return { success: false, output: "", error: `Skill not ready. Current state: ${skill.state.state}` };
        }

        const model = createChatModel(ConfigService.getInstance().getAiConfig());

        const subagent = createDeepAgent({
          model,
          systemPrompt: skill.instructions,
          tools: [thinkTool, runCmdTool, searchKnowledgeTool, addKnowledgeTool],
        });

        const result = await subagent.invoke({
          messages: [{ role: "user", content: input }],
        });

        logger.debug(`Skill "${skillName}" completed successfully`);

        const lastMessage = result.messages[result.messages.length - 1];
        const output: string = typeof lastMessage?.content === "string" ? lastMessage.content : "";

        return { success: true, output, error: null };
      } catch (err: unknown) {
        const errorMessage: string = err instanceof Error ? err.message : String(err);

        logger.error(`Skill "${skillName}" execution failed: ${errorMessage}`);

        return { success: false, output: "", error: errorMessage };
      }
    },
    {
      name: "call_skill",
      description:
        `Invoke a skill by name. The skill agent will execute with the given input and return its output. ` +
        `${skillListStr} ` +
        `Do NOT call this tool with any skill name not listed above. ` +
        `Web search is NOT a skill — use the searxng tool for search and crawl4ai for page fetching.`,
      schema: callSkillToolInputSchema,
    },
  );
}
