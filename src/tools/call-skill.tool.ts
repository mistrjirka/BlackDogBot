import { tool, ToolLoopAgent, hasToolCall, stepCountIs, LanguageModel, ToolSet } from "ai";

import { callSkillToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { LoggerService } from "../services/logger.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { getForceThinkDirective } from "../utils/prepare-step.js";
import { repairToolCallJsonAsync } from "../utils/tool-call-repair.js";
import { thinkTool } from "./think.tool.js";
import { doneTool } from "./done.tool.js";
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

export const callSkillTool = tool({
  description: "Invoke a skill by name. The skill agent will execute with the given input and return its output.",
  inputSchema: callSkillToolInputSchema,
  execute: async ({ skillName, input }: { skillName: string; input: string }): Promise<ICallSkillResult> => {
    const logger: LoggerService = LoggerService.getInstance();

    try {
      const skill: ISkill | undefined = SkillLoaderService.getInstance().getSkill(skillName);

      if (!skill) {
        return { success: false, output: "", error: `Skill not found: ${skillName}` };
      }

      if (skill.state.state !== "setuped") {
        return { success: false, output: "", error: `Skill not set up. Current state: ${skill.state.state}` };
      }

      const model: LanguageModel = AiProviderService.getInstance().getModel();

      const tools: ToolSet = {
        think: thinkTool,
        done: doneTool,
        run_cmd: runCmdTool,
        search_knowledge: searchKnowledgeTool,
        add_knowledge: addKnowledgeTool,
      };

      const agent: ToolLoopAgent = new ToolLoopAgent({
        model,
        instructions: skill.instructions,
        tools,
        stopWhen: [hasToolCall("done"), stepCountIs(MAX_SKILL_STEPS)],
        experimental_repairToolCall: repairToolCallJsonAsync,
        prepareStep: async ({ stepNumber, messages }) => {
          const forceThink = getForceThinkDirective(stepNumber, messages);

          if (forceThink) {
            return forceThink;
          }

          return {};
        },
      });

      const result = await agent.generate({ prompt: input });

      logger.debug(`Skill "${skillName}" completed successfully`);

      return { success: true, output: result.text, error: null };
    } catch (err: unknown) {
      const errorMessage: string = err instanceof Error ? err.message : String(err);

      logger.error(`Skill "${skillName}" execution failed: ${errorMessage}`);

      return { success: false, output: "", error: errorMessage };
    }
  },
});
