import { tool, ToolLoopAgent, stepCountIs, LanguageModel, ToolSet } from "ai";

import { callSkillToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { repairToolCallJsonAsync } from "../utils/tool-call-repair.js";
import { wrapToolSetWithReasoning } from "../utils/tool-reasoning-wrapper.js";
import { thinkTool } from "./think.tool.js";
import { runCmdTool } from "./run-cmd.tool.js";
import { searchKnowledgeTool } from "./search-knowledge.tool.js";
import { addKnowledgeTool } from "./add-knowledge.tool.js";
import type { ISkill } from "../shared/types/index.js";

//#region Interfaces

interface ICallSkillResult {
  success: boolean;
  output: string;
  error: string | null;
}

//#endregion Interfaces

//#region Constants

const MAX_SKILL_STEPS: number = 15;

//#endregion Constants

/**
 * Creates the call_skill tool with a dynamic description listing the currently
 * available skills. This prevents the model from hallucinating skill names.
 */
export function createCallSkillTool(availableSkillNames: string[]) {
  const skillListStr: string = availableSkillNames.length > 0
    ? `Available skills: ${availableSkillNames.join(", ")}.`
    : "No skills are currently loaded.";

  return tool({
    description:
      `Invoke a skill by name. The skill agent will execute with the given input and return its output. ` +
      `${skillListStr} ` +
      `Do NOT call this tool with any skill name not listed above. ` +
      `Web search is NOT a skill — use the searxng tool for search and crawl4ai for page fetching.`,
    inputSchema: callSkillToolInputSchema,
    execute: async ({ skillName, input }: { skillName: string; input: string }): Promise<ICallSkillResult> => {
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

        const model: LanguageModel = AiProviderService.getInstance().getModel();

        const tools: ToolSet = {
          think: thinkTool,
          run_cmd: runCmdTool,
          search_knowledge: searchKnowledgeTool,
          add_knowledge: addKnowledgeTool,
        };

        const wrappedTools: ToolSet = wrapToolSetWithReasoning(tools, {
          logger,
        });

        const agent: ToolLoopAgent = new ToolLoopAgent({
          model,
          instructions: skill.instructions,
          tools: wrappedTools,
          stopWhen: [stepCountIs(MAX_SKILL_STEPS)],
          experimental_repairToolCall: repairToolCallJsonAsync,
        });

        const result = await agent.generate({ prompt: input });

        logger.debug(`Skill "${skillName}" completed successfully`);

        return { success: true, output: result.text, error: null };
      } catch (err: unknown) {
        const errorMessage: string = extractErrorMessage(err);

        logger.error(`Skill "${skillName}" execution failed: ${errorMessage}`);

        return { success: false, output: "", error: errorMessage };
      }
    },
  });
}
