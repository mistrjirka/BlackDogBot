import type { ToolSet, LanguageModel } from "ai";
import type { Tool } from "ai";

import { BaseAgentBase } from "./base-agent.js";
import type { IAgentResult, IToolCallSummary } from "./base-agent.js";
import type { IScheduledTask } from "../shared/types/index.js";
import { PROMPT_CRON_AGENT } from "../shared/constants.js";
import { PromptService } from "../services/prompt.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { ConfigService } from "../services/config.service.js";
import { getCurrentDateTime } from "../utils/time.js";
import {
  thinkTool,
  runCmdTool,
  searxngTool,
  crawl4aiTool,
  searchKnowledgeTool,
  addKnowledgeTool,
  editKnowledgeTool,
  createSendMessageToolWithHistory,
  createGetPreviousMessageTool,
  createCallSkillTool,
  getSkillFileTool,
  createRunJobTool,
  getJobsTool,
  listCronsTool,
  createReadFileTool,
  createWriteFileTool,
  appendFileTool,
  editFileTool,
  fetchRssTool,
  listDatabasesTool,
  listTablesTool,
  getTableSchemaTool,
  createDatabaseTool,
  createTableTool,
  dropTableTool,
  queryDatabaseTool,
  FileReadTracker,
  JobActivityTracker,
} from "../tools/index.js";
import type { MessageSender, TaskIdProvider } from "../tools/index.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";

export class CronAgent extends BaseAgentBase {
  //#region Data members

  private static _instance: CronAgent | null;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    const cronAgentDefaultMaxSteps: number = 100;
    const rawSteps: number = parseInt(process.env.BETTERCLAW_CRON_AGENT_MAX_STEPS ?? "", 10);

    super({ maxSteps: isNaN(rawSteps) ? cronAgentDefaultMaxSteps : rawSteps });
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
    taskIdProvider: TaskIdProvider,
  ): Promise<IAgentResult> {
    const basePrompt: string = await PromptService.getInstance().getPromptAsync(
      PROMPT_CRON_AGENT,
    );

    const config = ConfigService.getInstance().getConfig();
    const currentDateTime = getCurrentDateTime(config.scheduler?.timezone);

    const instructions: string =
      basePrompt +
      `\n\n<task_context>\nTask: ${task.name}\nDescription: ${task.description}\nCurrent time: ${currentDateTime}\nInstructions: ${task.instructions}\n</task_context>`;

    const tools: ToolSet = this._resolveTools(task.tools, messageSender, taskIdProvider);
    const model: LanguageModel = AiProviderService.getInstance().getModel();

    const onStepAsync = async (
      stepNumber: number,
      toolCalls: IToolCallSummary[],
    ): Promise<void> => {
      for (const tc of toolCalls) {
        const argsStr = JSON.stringify(tc.input).slice(0, 500);
        const resultStr = tc.result !== undefined 
          ? JSON.stringify(tc.result).slice(0, 500) 
          : "(pending)";
        this._logger.debug(`Step ${stepNumber}: tool_call ${tc.name} ${argsStr}`);
        this._logger.debug(`Step ${stepNumber}: tool_result ${tc.name} ${resultStr}`);
      }
    };

    this._buildAgent(model, instructions, tools, onStepAsync);

    return this.processMessageAsync(
      "Execute the scheduled task according to your instructions.",
    );
  }

  //#endregion Public methods

  //#region Private methods

  private _resolveTools(
    toolNames: string[],
    messageSender: MessageSender,
    taskIdProvider: TaskIdProvider,
  ): ToolSet {
    const readTracker: FileReadTracker = new FileReadTracker();
    const jobTracker: JobActivityTracker = new JobActivityTracker();

    const availableTools: Record<string, Tool> = {
      think: thinkTool,
      run_cmd: runCmdTool,
      search_knowledge: searchKnowledgeTool,
      add_knowledge: addKnowledgeTool,
      edit_knowledge: editKnowledgeTool,
      send_message: createSendMessageToolWithHistory(messageSender, taskIdProvider),
      get_previous_message: createGetPreviousMessageTool(taskIdProvider),
      read_file: createReadFileTool(readTracker),
      write_file: createWriteFileTool(readTracker),
      append_file: appendFileTool,
      edit_file: editFileTool,
      run_job: createRunJobTool(jobTracker, undefined, messageSender),
      get_jobs: getJobsTool,
      list_crons: listCronsTool,
      fetch_rss: fetchRssTool,
      searxng: searxngTool,
      crawl4ai: crawl4aiTool,
      list_databases: listDatabasesTool,
      list_tables: listTablesTool,
      get_table_schema: getTableSchemaTool,
      create_database: createDatabaseTool,
      create_table: createTableTool,
      drop_table: dropTableTool,
      query_database: queryDatabaseTool,
    };

    // Only include skill tools if skills are loaded
    const availableSkills = SkillLoaderService.getInstance().getAvailableSkills();
    if (availableSkills.length > 0) {
      const skillNames = availableSkills.map((s) => s.name);
      availableTools.call_skill = createCallSkillTool(skillNames);
      availableTools.get_skill_file = getSkillFileTool;
    }

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
