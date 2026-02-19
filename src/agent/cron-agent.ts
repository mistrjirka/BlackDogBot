import type { ToolSet, LanguageModel } from "ai";
import type { Tool } from "ai";

import { BaseAgentBase } from "./base-agent.js";
import type { IAgentResult } from "./base-agent.js";
import type { IScheduledTask } from "../shared/types/index.js";
import { PROMPT_CRON_AGENT } from "../shared/constants.js";
import { PromptService } from "../services/prompt.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import {
  thinkTool,
  runCmdTool,
  searchKnowledgeTool,
  addKnowledgeTool,
  editKnowledgeTool,
  createSendMessageTool,
  callSkillTool,
  getSkillFileTool,
  runJobTool,
  getJobsTool,
  listCronsTool,
  createReadFileTool,
  createWriteFileTool,
  appendFileTool,
  editFileTool,
  FileReadTracker,
} from "../tools/index.js";
import type { MessageSender } from "../tools/index.js";

export class CronAgent extends BaseAgentBase {
  //#region Data members

  private static _instance: CronAgent | null;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    super({ maxSteps: 15 });
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): CronAgent {
    if (!CronAgent._instance) {
      CronAgent._instance = new CronAgent();
    }

    return CronAgent._instance;
  }

  public async executeTaskAsync(
    task: IScheduledTask,
    messageSender: MessageSender,
  ): Promise<IAgentResult> {
    const basePrompt: string = await PromptService.getInstance().getPromptAsync(
      PROMPT_CRON_AGENT,
    );

    const instructions: string =
      basePrompt +
      `\n\n<task_context>\nTask: ${task.name}\nDescription: ${task.description}\nInstructions: ${task.instructions}\n</task_context>`;

    const tools: ToolSet = this._resolveTools(task.tools, messageSender);
    const model: LanguageModel = AiProviderService.getInstance().getModel();

    this._buildAgent(model, instructions, tools);

    return this.processMessageAsync(
      "Execute the scheduled task according to your instructions.",
    );
  }

  //#endregion Public methods

  //#region Private methods

  private _resolveTools(
    toolNames: string[],
    messageSender: MessageSender,
  ): ToolSet {
    const readTracker: FileReadTracker = new FileReadTracker();

    const availableTools: Record<string, Tool> = {
      think: thinkTool,
      run_cmd: runCmdTool,
      search_knowledge: searchKnowledgeTool,
      add_knowledge: addKnowledgeTool,
      edit_knowledge: editKnowledgeTool,
      send_message: createSendMessageTool(messageSender),
      read_file: createReadFileTool(readTracker),
      write_file: createWriteFileTool(readTracker),
      append_file: appendFileTool,
      edit_file: editFileTool,
      call_skill: callSkillTool,
      get_skill_file: getSkillFileTool,
      run_job: runJobTool,
      get_jobs: getJobsTool,
      list_crons: listCronsTool,
    };

    const resolvedTools: ToolSet = {};

    for (const toolName of toolNames) {
      const tool: Tool | undefined = availableTools[toolName];

      if (!tool) {
        this._logger.warn(`Unknown tool name "${toolName}" — skipping.`);
        continue;
      }

      resolvedTools[toolName] = tool;
    }

    return resolvedTools;
  }

  //#endregion Private methods
}
