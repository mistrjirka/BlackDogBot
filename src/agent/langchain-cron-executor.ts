import type { DynamicStructuredTool } from "langchain";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { AIMessage } from "@langchain/core/messages";
import path from "node:path";
import os from "node:os";

import { LoggerService } from "../services/logger.service.js";
import { ConfigService } from "../services/config.service.js";
import { PromptService } from "../services/prompt.service.js";
import { AiCapabilityService } from "../services/ai-capability.service.js";
import { createLangchainAgent } from "./langchain-agent.js";
import type { IAgentResult } from "./types.js";
import type { IScheduledTask, IExecutionContext } from "../shared/types/cron.types.js";
import { PROMPT_CRON_AGENT } from "../shared/constants.js";
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
  type MessageSender,
  type TaskIdProvider,
} from "../tools/index.js";
import { buildPerTableToolsAsync } from "../utils/per-table-tools.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { CRON_TOOL_ALIASES } from "../shared/schemas/tool-schemas.js";

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

//#region LangchainCronExecutor

export class LangchainCronExecutor {
  private static _instance: LangchainCronExecutor | null = null;
  private _logger = LoggerService.getInstance();

  public static getInstance(): LangchainCronExecutor {
    if (!LangchainCronExecutor._instance) {
      LangchainCronExecutor._instance = new LangchainCronExecutor();
    }
    return LangchainCronExecutor._instance;
  }

  public async executeTaskAsync(
    task: IScheduledTask,
    messageSender: MessageSender,
    taskIdProvider: TaskIdProvider,
    executionContext: IExecutionContext,
    _traceCollector?: ITraceCollector,
  ): Promise<IAgentResult> {
    executionContext.taskName = task.name;
    executionContext.taskDescription = task.description;
    executionContext.taskInstructions = task.instructions;

    thinkTracker.reset();

    const basePrompt: string = await PromptService.getInstance().getPromptAsync(
      PROMPT_CRON_AGENT,
    );

    const config = ConfigService.getInstance().getConfig();
    const currentDateTime = getCurrentDateTime(config.scheduler?.timezone);

    const instructions: string =
      basePrompt +
      `\n\n<task_context>\nTask: ${task.name}\nDescription: ${task.description}\nCurrent time: ${currentDateTime}\nInstructions: ${task.instructions}\n</task_context>`;

    const readTracker: FileReadTracker = new FileReadTracker();
    const tools: DynamicStructuredTool[] = await this._resolveToolsAsync(
      task.tools,
      messageSender,
      taskIdProvider,
      executionContext,
      readTracker,
    );

    const aiConfig = config.ai;
    const checkpointer = await this._getCheckpointer();
    const agent = createLangchainAgent({
      aiConfig,
      systemPrompt: instructions,
      tools,
      checkpointer,
    });

    const threadId = `cron-${task.taskId}`;
    const result = await agent.invoke(
      { messages: [{ role: "user", content: "Execute the scheduled task according to your instructions." }] },
      { configurable: { thread_id: threadId } },
    );

    const lastMessage = result.messages[result.messages.length - 1];
    const responseText: string = typeof lastMessage?.content === "string"
      ? lastMessage.content
      : "";

    let stepsCount: number = 0;
    for (const msg of result.messages) {
      if (msg._getType() === "ai") {
        const aiMsg = msg as AIMessage;
        if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
          stepsCount++;
        }
      }
    }

    this._logger.info("Cron task execution complete", {
      taskId: task.taskId,
      taskName: task.name,
      stepsCount,
      responseLength: responseText.length,
    });

    return {
      text: responseText,
      stepsCount,
    };
  }

  private async _resolveToolsAsync(
    toolNames: string[],
    messageSender: MessageSender,
    taskIdProvider: TaskIdProvider,
    executionContext: IExecutionContext,
    readTracker: FileReadTracker,
  ): Promise<DynamicStructuredTool[]> {
    const supportsVision: boolean = AiCapabilityService.getInstance().getSupportsVision();

    const availableTools: Record<string, DynamicStructuredTool> = {
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
      update_database: updateDatabaseTool,
      delete_from_database: deleteFromDatabaseTool,
    };

    if (supportsVision) {
      availableTools.read_image = createReadImageTool(readTracker);
    }

    try {
      const perTableTools = await buildPerTableToolsAsync();
      for (const [name, toolDef] of Object.entries(perTableTools)) {
        availableTools[name] = toolDef as DynamicStructuredTool;
      }
    } catch (err: unknown) {
      this._logger.warn("Failed to build per-table tools for cron executor", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const availableSkills = SkillLoaderService.getInstance().getAvailableSkills();
    if (availableSkills.length > 0) {
      const skillNames = availableSkills.map((s) => s.name);
      availableTools.call_skill = createCallSkillTool(skillNames);
      availableTools.get_skill_file = getSkillFileTool;
    }

    const resolvedTools: DynamicStructuredTool[] = [];
    const effectiveToolNames: string[] = [];

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
      const tool: DynamicStructuredTool | undefined = availableTools[toolName];

      if (!tool) {
        this._logger.warn(`Unknown tool name "${toolName}" — skipping.`);
        continue;
      }

      resolvedTools.push(tool);
    }

    return resolvedTools;
  }

  private async _getCheckpointer(): Promise<SqliteSaver> {
    const baseDir = path.join(os.homedir(), ".blackdogbot");
    const dbPath = path.join(baseDir, "cron-checkpoints.db");
    return SqliteSaver.fromConnString(dbPath);
  }
}