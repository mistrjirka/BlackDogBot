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
import { extractErrorMessage } from "../utils/error.js";
import { getCurrentDateTime } from "../utils/time.js";
import {
  thinkTool,
  thinkTracker,
  runCmdTool,
  runCmdInputTool,
  getCmdStatusTool,
  getCmdOutputTool,
  waitForCmdTool,
  stopCmdTool,
  searxngTool,
  crawl4aiTool,
  searchKnowledgeTool,
  addKnowledgeTool,
  editKnowledgeTool,
  createSendMessageToolWithHistory,
  createGetPreviousMessageTool,
  createCallSkillTool,
  getSkillFileTool,
  listTimedTool,
  createReadFileTool,
  createReadImageTool,
  createWriteFileTool,
  appendFileTool,
  editFileTool,
  fetchRssTool,
  listTablesTool,
  getTableSchemaTool,
  createTableTool,
  dropTableTool,
  readFromDatabaseTool,
  deleteFromDatabaseTool,
  FileReadTracker,
} from "../tools/index.js";
import type { MessageSender, TaskIdProvider } from "../tools/index.js";
import { StatusService } from "../services/status.service.js";
import { buildPerTableToolsAsync, buildUpdateTableToolsAsync } from "../utils/per-table-tools.js";
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

interface ICronRebuildInfo {
  toolName: string;
  tableName: string;
}

//#endregion Interfaces

export class CronAgent extends BaseAgentBase {
  //#region Data members

  private static _instance: CronAgent | null;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    const cronAgentDefaultMaxSteps: number = 300;
    const rawSteps: number = parseInt(
      process.env.BLACKDOGBOT_CRON_AGENT_MAX_STEPS ?? "",
      10,
    );

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
    executionContext.taskName = task.name;
    executionContext.taskDescription = task.description;
    executionContext.taskInstructions = task.instructions;

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

    let pendingRebuild: ICronRebuildInfo | null = null;
    let rebuildCount: number = 0;
    const maxRebuildRestarts: number = 2;

    const resolveToolsAsync = async (): Promise<ToolSet> => this._resolveTools(
      task.tools,
      messageSender,
      taskIdProvider,
      executionContext,
      (info: ICronRebuildInfo): void => {
        pendingRebuild = info;
      },
    );

    let tools: ToolSet = await resolveToolsAsync();
    
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
          // Note: _estimatedInputTokens and _providerInputTokens don't exist on BaseAgentBase,
          // using _totalInputTokens as the authoritative token count from the AI provider.
          estimatedInputTokens: this._totalInputTokens,
          providerInputTokens: this._totalInputTokens,
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

    this._buildAgent(
      model,
      instructions,
      tools,
      onStepAsync,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (): boolean => pendingRebuild !== null,
    );

    let currentInstruction: string = "Execute the scheduled task according to your instructions.";

    while (true) {
      const result: IAgentResult = await this.processMessageAsync(currentInstruction);

      if (pendingRebuild !== null && rebuildCount < maxRebuildRestarts) {
        const info: ICronRebuildInfo = pendingRebuild;
        pendingRebuild = null;
        rebuildCount++;

        this._logger.info("Cron create_table triggered tool rebuild, restarting run", {
          taskId: task.taskId,
          taskName: task.name,
          toolName: info.toolName,
          tableName: info.tableName,
          restartCount: rebuildCount,
        });

        tools = await resolveToolsAsync();

        this._buildAgent(
          model,
          instructions,
          tools,
          onStepAsync,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (): boolean => pendingRebuild !== null,
        );

        currentInstruction = `[System] A new tool "${info.toolName}" for the "${info.tableName}" table is now available. Continue the task and use it when needed.`;
        continue;
      }

      const pendingToolName: string | undefined = (pendingRebuild as ICronRebuildInfo | null)?.toolName;
      if (pendingToolName && rebuildCount >= maxRebuildRestarts) {
        this._logger.warn("Cron tool rebuild restart budget exhausted", {
          taskId: task.taskId,
          taskName: task.name,
          maxRestarts: maxRebuildRestarts,
          pendingTool: pendingToolName,
        });
        pendingRebuild = null;
      }

      return result;
    }
  }

  //#endregion Public methods

  //#region Private methods

  private async _resolveTools(
    toolNames: string[],
    messageSender: MessageSender,
    taskIdProvider: TaskIdProvider,
    executionContext: IExecutionContext,
    onCreateTableRebuild?: (info: ICronRebuildInfo) => void,
  ): Promise<ToolSet> {
    const readTracker: FileReadTracker = new FileReadTracker();
    const supportsVision: boolean = AiProviderService.getInstance().getSupportsVision();

    const availableTools: Record<string, Tool> = {
      think: thinkTool,
      run_cmd: runCmdTool,
      run_cmd_input: runCmdInputTool,
      get_cmd_status: getCmdStatusTool,
      get_cmd_output: getCmdOutputTool,
      wait_for_cmd: waitForCmdTool,
      stop_cmd: stopCmdTool,
      search_knowledge: searchKnowledgeTool,
      add_knowledge: addKnowledgeTool,
      edit_knowledge: editKnowledgeTool,
      send_message: createSendMessageToolWithHistory(messageSender, taskIdProvider, executionContext),
      get_previous_message: createGetPreviousMessageTool(executionContext),
      read_file: createReadFileTool(readTracker),
      write_file: createWriteFileTool(readTracker),
      append_file: appendFileTool,
      edit_file: editFileTool,
      list_timed: listTimedTool,
      fetch_rss: fetchRssTool,
      searxng: searxngTool,
      crawl4ai: crawl4aiTool,
      list_tables: listTablesTool,
      get_table_schema: getTableSchemaTool,
      create_table: _wrapCronCreateTableTool(createTableTool, onCreateTableRebuild),
      drop_table: dropTableTool,
      read_from_database: readFromDatabaseTool,
      delete_from_database: deleteFromDatabaseTool,
    };

    if (supportsVision) {
      availableTools.read_image = createReadImageTool(readTracker);
    }

    // Merge per-table write tools
    try {
      const [writeTools, updateTools] = await Promise.all([
        buildPerTableToolsAsync(),
        buildUpdateTableToolsAsync(),
      ]);
      for (const [name, toolDef] of Object.entries(writeTools)) {
        availableTools[name] = toolDef;
      }
      for (const [name, toolDef] of Object.entries(updateTools)) {
        availableTools[name] = toolDef;
      }
    } catch (err: unknown) {
      this._logger.warn("Failed to build per-table tools for cron agent", {
        error: extractErrorMessage(err),
      });
    }

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

function _wrapCronCreateTableTool(
  originalTool: Tool,
  onCreateTableRebuild?: (info: ICronRebuildInfo) => void,
): Tool {
  const originalExecute = originalTool.execute;

  if (!originalExecute) {
    return originalTool;
  }

  return {
    ...originalTool,
    execute: async (input: unknown, options: any): Promise<unknown> => {
      const result: any = await originalExecute(input, options);

      if (result?.success === true && onCreateTableRebuild) {
        const tableName: string = typeof input === "object" && input !== null
          ? String((input as Record<string, unknown>).tableName ?? (input as Record<string, unknown>).name ?? "unknown")
          : "unknown";

        onCreateTableRebuild({
          toolName: `write_table_${tableName}`,
          tableName,
        });
      }

      return result;
    },
  };
}
