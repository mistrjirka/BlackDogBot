import type { DynamicStructuredTool } from "langchain";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { LoggerService } from "../services/logger.service.js";
import { ConfigService } from "../services/config.service.js";
import { PromptService } from "../services/prompt.service.js";
import { AiCapabilityService } from "../services/ai-capability.service.js";
import { createLangchainAgent } from "./langchain-agent.js";
import type { IAgentResult } from "./types.js";
import type { IScheduledTask, IExecutionContext } from "../shared/types/cron.types.js";
import { PROMPT_CRON_AGENT } from "../shared/constants.js";
import { getCurrentDateTime } from "../utils/time.js";
import { isContextExceededApiError, isLlamaCppParseError } from "../utils/context-error.js";
import { getDisableThinkingOnRetry } from "../services/langchain-model.service.js";

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
  deleteFromDatabaseTool,
  FileReadTracker,
  type MessageSender,
  type TaskIdProvider,
} from "../tools/index.js";
import { buildPerTableToolsAsync } from "../utils/per-table-tools.js";
import { SkillLoaderService } from "../services/skill-loader.service.js";
import { CRON_TOOL_ALIASES } from "../shared/schemas/tool-schemas.js";
import {
  buildToolResultPreview,
  extractNormalizedCronResponseText,
  resolveToolCallsFromAiMessage,
} from "./langchain-cron-executor-helpers.js";

//#endregion Imports

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
  ): Promise<IAgentResult> {
    executionContext.taskName = task.name;
    executionContext.taskDescription = task.description;
    executionContext.taskInstructions = task.instructions;

    thinkTracker.reset();

    const basePrompt: string = await PromptService.getInstance().getPromptAsync(
      PROMPT_CRON_AGENT,
    );

    await this._saveSystemPromptDebugFileAsync("cron-agent", basePrompt);

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
    const agent = createLangchainAgent({
      aiConfig,
      systemPrompt: instructions,
      tools,
    }).withConfig({
      recursionLimit: 200,
    });

    const maxRetries: number = 2;
    let lastError: Error | null = null;
    let parseRetryAttempt = false;
    let useDisableThinking = false;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const currentAgent = useDisableThinking
          ? createLangchainAgent({
              aiConfig,
              systemPrompt: instructions,
              tools,
              disableThinking: true,
            }).withConfig({
              recursionLimit: 200,
            })
          : agent;

        const result = await currentAgent.invoke(
          { messages: [{ role: "user", content: "Execute the scheduled task according to your instructions." }] },
          { configurable: { thread_id: `cron-${task.taskId}` } },
        );

        const lastMessage = result.messages[result.messages.length - 1];

        const responseText: string = extractNormalizedCronResponseText(result.messages);

        let stepsCount: number = 0;

        // Log all AI messages for debugging
        for (let i = 0; i < result.messages.length; i++) {
          const msg = result.messages[i];
          if (msg._getType() === "ai") {
            const aiMsg = msg as AIMessage;
            this._logger.debug("Cron AI message", {
              taskId: task.taskId,
              messageIndex: i,
              hasToolCalls: aiMsg.tool_calls && aiMsg.tool_calls.length > 0,
              toolCallsCount: aiMsg.tool_calls?.length ?? 0,
              toolNames: aiMsg.tool_calls?.map((tc) => tc.name) ?? [],
              contentPreview: typeof aiMsg.content === "string"
                ? aiMsg.content.slice(0, 200)
                : JSON.stringify(aiMsg.content).slice(0, 200),
            });
          }
        }

        // Log each tool step with colored formatting
        for (const msg of result.messages) {
          if (msg._getType() === "ai") {
            const aiMsg = msg as AIMessage;
            const resolvedToolCalls = resolveToolCallsFromAiMessage(aiMsg);

            if (resolvedToolCalls.length > 0) {
              for (const tc of resolvedToolCalls) {
                stepsCount++;

                const toolResultMsg = result.messages.find((m: BaseMessage): boolean => {
                  if (m._getType() !== "tool") {
                    return false;
                  }

                  const toolMessage = m as unknown as { name?: string; tool_call_id?: string };

                  if (tc.id && toolMessage.tool_call_id) {
                    return toolMessage.tool_call_id === tc.id;
                  }

                  return toolMessage.name === tc.name;
                });

                const outputPreview: string = buildToolResultPreview(toolResultMsg);

                // Log step with colored formatting
                this._logger.logStep(
                  stepsCount,
                  tc.name,
                  tc.args as Record<string, unknown>,
                  outputPreview,
                );
              }
            }
          }
        }

        // Always log the final response (including empty), so termination is visible.
        this._logger.logFinalResponse(responseText, {
          taskId: task.taskId,
          taskName: task.name,
          stepsCount,
          messageCount: result.messages.length,
          lastMessageType: lastMessage?._getType() ?? "none",
        });

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
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (isContextExceededApiError(error) && attempt < maxRetries - 1) {
          this._logger.warn("Cron context limit exceeded, retrying fresh", {
            taskId: task.taskId,
            taskName: task.name,
            attempt: attempt + 1,
          });
          continue;
        }

        if (isLlamaCppParseError(error) && !parseRetryAttempt) {
          const disableThinking = getDisableThinkingOnRetry(aiConfig);
          if (disableThinking) {
            parseRetryAttempt = true;
            useDisableThinking = true;
            this._logger.warn("llama.cpp parse error detected, retrying with thinking disabled", {
              taskId: task.taskId,
              taskName: task.name,
              errorMessage: lastError.message,
            });
            continue;
          }
        }

        throw lastError;
      }
    }

    throw lastError ?? new Error("Unexpected error in executeTaskAsync");
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

  private async _saveSystemPromptDebugFileAsync(name: string, content: string): Promise<void> {
    const debugDir = path.join(os.homedir(), ".blackdogbot", "debug");
    await fs.mkdir(debugDir, { recursive: true }).catch(() => {});
    const debugPath = path.join(debugDir, `system-prompt-${name}.txt`);
    await fs.writeFile(debugPath, content, "utf-8");
    this._logger.debug("System prompt saved to debug file", { path: debugPath });
  }
}
