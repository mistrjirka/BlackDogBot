import type { ToolSet, LanguageModel } from "ai";
import type { Tool } from "ai";

import { BaseAgentBase } from "./base-agent.js";
import type { IAgentResult, IToolCallSummary } from "./base-agent.js";
import type { IScheduledTask, IExecutionContext } from "../shared/types/index.js";
import { PROMPT_CRON_AGENT } from "../shared/constants.js";
import { CRON_TOOL_ALIASES } from "../shared/schemas/tool-schemas.js";
import { PromptService } from "../services/prompt.service.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { ConfigService } from "../services/config.service.js";
import { getCurrentDateTime } from "../utils/time.js";
import {
  thinkTool,
  thinkTracker,
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
  readFromDatabaseTool,
  writeToDatabaseTool,
  updateDatabaseTool,
  deleteFromDatabaseTool,
  FileReadTracker,
  JobActivityTracker,
} from "../tools/index.js";
import type { MessageSender, TaskIdProvider } from "../tools/index.js";
import { StatusService } from "../services/status.service.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";

//#region Interfaces

export interface IToolCallTrace {
  step: number;
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  isError: boolean;
}

export interface ITraceCollector {
  addTrace(trace: IToolCallTrace): void;
}

//#endregion Interfaces

export class CronAgent extends BaseAgentBase {
  //#region Data members

  private static _instance: CronAgent | null;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    const cronAgentDefaultMaxSteps: number = 300;
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
    executionContext: IExecutionContext,
    traceCollector?: ITraceCollector,
  ): Promise<IAgentResult> {
    // Reset think operation tracker at the start of each task
    thinkTracker.reset();

    // Reset stale compaction flag from any previous task execution.
    // CronAgent is a singleton — without this reset, a context-exceeded error
    // in one task would force compaction on the NEXT task even if its context
    // is tiny (e.g. 5k tokens at 5% utilization).
    this._forceCompactionOnNextStep = false;
    
    const basePrompt: string = await PromptService.getInstance().getPromptAsync(
      PROMPT_CRON_AGENT,
    );

    const config = ConfigService.getInstance().getConfig();
    const currentDateTime = getCurrentDateTime(config.scheduler?.timezone);

    const instructions: string =
      basePrompt +
      `\n\n<task_context>\nTask: ${task.name}\nDescription: ${task.description}\nCurrent time: ${currentDateTime}\nInstructions: ${task.instructions}\n</task_context>`;

    const tools: ToolSet = this._resolveTools(task.tools, messageSender, taskIdProvider, executionContext);
    
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model: LanguageModel = aiProviderService.getModel();
    const contextWindow: number = aiProviderService.getContextWindow();
    this.updateContextWindow(contextWindow);

    const statusService: StatusService = StatusService.getInstance();

    const onStepAsync = async (
      stepNumber: number,
      toolCalls: IToolCallSummary[],
    ): Promise<void> => {
      // Update spinner label so concurrent user sessions don't leave a stale label
      const toolNames: string = toolCalls.map((tc) => tc.name).join(", ");
      statusService.setStatus("tool_execution", `Cron: ${task.name} — Step ${stepNumber}: ${toolNames}`, {
        stepNumber,
        taskName: task.name,
      });

      // Log token usage at each step to track accumulation during long-running tasks
      if (this._totalInputTokens > 0) {
        const hardLimit = Math.floor(this._contextWindow * 0.85);
        const utilization = (this._totalInputTokens / this._contextWindow) * 100;
        
        this._logger.info(`Step ${stepNumber}: Token usage tracking`, {
          totalInputTokens: this._totalInputTokens,
          contextWindow: this._contextWindow,
          utilization: `${utilization.toFixed(1)}%`,
          hardLimit: hardLimit,
          remainingTokens: Math.max(0, hardLimit - this._totalInputTokens),
        });
      }

      for (const tc of toolCalls) {
        const argsStr = JSON.stringify(tc.input).slice(0, 500);
        const resultStr = tc.result !== undefined 
          ? JSON.stringify(tc.result).slice(0, 500) 
          : "(pending)";
        this._logger.debug(`Step ${stepNumber}: tool_call ${tc.name} ${argsStr}`);
        this._logger.debug(`Step ${stepNumber}: tool_result ${tc.name} ${resultStr}`);

        if (traceCollector) {
          traceCollector.addTrace({
            step: stepNumber,
            name: tc.name,
            input: tc.input,
            output: tc.result,
            isError: tc.isError ?? false,
          });
        }
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
    executionContext: IExecutionContext,
  ): ToolSet {
    const readTracker: FileReadTracker = new FileReadTracker();
    const jobTracker: JobActivityTracker = new JobActivityTracker();

    const availableTools: Record<string, Tool> = {
      think: thinkTool,
      run_cmd: runCmdTool,
      search_knowledge: searchKnowledgeTool,
      add_knowledge: addKnowledgeTool,
      edit_knowledge: editKnowledgeTool,
      send_message: createSendMessageToolWithHistory(messageSender, taskIdProvider, executionContext),
      get_previous_message: createGetPreviousMessageTool(executionContext),
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
      read_from_database: readFromDatabaseTool,
      write_to_database: writeToDatabaseTool,
      update_database: updateDatabaseTool,
      delete_from_database: deleteFromDatabaseTool,
    };

    // Only include skill tools if skills are loaded
    const availableSkills = SkillLoaderService.getInstance().getAvailableSkills();
    if (availableSkills.length > 0) {
      const skillNames = availableSkills.map((s) => s.name);
      availableTools.call_skill = createCallSkillTool(skillNames);
      availableTools.get_skill_file = getSkillFileTool;
    }

    const resolvedTools: ToolSet = {};
    const effectiveToolNames: string[] = [];

    // Expand deprecated tool aliases (e.g. query_database → 4 dedicated tools)
    for (const name of toolNames) {
      const replacements: readonly string[] | undefined = CRON_TOOL_ALIASES[name];
      if (replacements) {
        this._logger.warn(
          `Deprecated tool "${name}" in cron task — expanded to: ${replacements.join(", ")}. Update the task to remove this warning.`,
        );
        for (const replacement of replacements) {
          if (!effectiveToolNames.includes(replacement)) {
            effectiveToolNames.push(replacement);
          }
        }
      } else {
        effectiveToolNames.push(name);
      }
    }

    // If send_message is available, force-include get_previous_message so the
    // model can satisfy the send-message prerequisite consistently.
    if (
      effectiveToolNames.includes("send_message") &&
      !effectiveToolNames.includes("get_previous_message")
    ) {
      effectiveToolNames.push("get_previous_message");
      this._logger.warn(
        "Auto-injecting get_previous_message for cron task because send_message is enabled.",
      );
    }

    for (const toolName of effectiveToolNames) {
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
