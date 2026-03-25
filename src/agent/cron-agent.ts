/**
 * @deprecated PHASE 5 - This file will be deleted when Vercel AI SDK is removed.
 * Cron execution is replaced by DeepAgents subagent in langchain-agent.ts.
 * See MIGRATION_PLAN.md Phase 5 for deletion timeline.
 */
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
  listCronsTool,
  createReadFileTool,
  createReadImageTool,
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
  updateDatabaseTool,
  deleteFromDatabaseTool,
  FileReadTracker,
} from "../tools/index.js";
import type { MessageSender, TaskIdProvider } from "../tools/index.js";
import { StatusService } from "../services/status.service.js";
import { buildPerTableToolsAsync } from "../utils/per-table-tools.js";
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
      process.env.BLACKDOGBOT_CRON_AGENT_MAX_STEPS ?? process.env.BETTERCLAW_CRON_AGENT_MAX_STEPS ?? "",
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
      think: thinkTool as unknown as Tool,
      run_cmd: runCmdTool as unknown as Tool,
      run_cmd_input: runCmdInputTool as unknown as Tool,
      get_cmd_status: getCmdStatusTool as unknown as Tool,
      get_cmd_output: getCmdOutputTool as unknown as Tool,
      wait_for_cmd: waitForCmdTool as unknown as Tool,
      stop_cmd: stopCmdTool as unknown as Tool,
      search_knowledge: searchKnowledgeTool as unknown as Tool,
      add_knowledge: addKnowledgeTool as unknown as Tool,
      edit_knowledge: editKnowledgeTool as unknown as Tool,
      send_message: createSendMessageToolWithHistory(messageSender, taskIdProvider, executionContext) as unknown as Tool,
      get_previous_message: createGetPreviousMessageTool(executionContext) as unknown as Tool,
      read_file: createReadFileTool(readTracker) as unknown as Tool,
      write_file: createWriteFileTool(readTracker) as unknown as Tool,
      append_file: appendFileTool as unknown as Tool,
      edit_file: editFileTool as unknown as Tool,
      list_crons: listCronsTool as unknown as Tool,
      fetch_rss: fetchRssTool as unknown as Tool,
      searxng: searxngTool as unknown as Tool,
      crawl4ai: crawl4aiTool as unknown as Tool,
      list_databases: listDatabasesTool as unknown as Tool,
      list_tables: listTablesTool as unknown as Tool,
      get_table_schema: getTableSchemaTool as unknown as Tool,
      create_database: createDatabaseTool as unknown as Tool,
      create_table: _wrapCronCreateTableTool(createTableTool as unknown as Tool, onCreateTableRebuild),
      drop_table: dropTableTool as unknown as Tool,
      read_from_database: readFromDatabaseTool as unknown as Tool,
      update_database: updateDatabaseTool as unknown as Tool,
      delete_from_database: deleteFromDatabaseTool as unknown as Tool,
    };

    if (supportsVision) {
      availableTools.read_image = createReadImageTool(readTracker) as unknown as Tool;
    }

    // Merge per-table write tools
    try {
      const perTableTools = asVercelToolSet(await buildPerTableToolsAsync());
      for (const [name, toolDef] of Object.entries(perTableTools)) {
        availableTools[name] = toolDef;
      }
    } catch (err: unknown) {
      this._logger.warn("Failed to build per-table tools for cron agent", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Only include skill tools if skills are loaded
    const availableSkills = SkillLoaderService.getInstance().getAvailableSkills();
    if (availableSkills.length > 0) {
      const skillNames = availableSkills.map((s) => s.name);
      availableTools.call_skill = createCallSkillTool(skillNames) as unknown as Tool;
      availableTools.get_skill_file = getSkillFileTool as unknown as Tool;
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
  const originalExecute = (originalTool as Record<string, unknown>).execute;

  if (typeof originalExecute !== "function") {
    return originalTool;
  }

  return {
    ...originalTool,
    execute: async (input: unknown, options: unknown): Promise<unknown> => {
      const result: unknown = await (originalExecute as (input: unknown, options: unknown) => Promise<unknown>)(input, options);

      if (typeof result === "object" && result !== null && (result as Record<string, unknown>).success === true && onCreateTableRebuild) {
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
  } as Tool;
}
