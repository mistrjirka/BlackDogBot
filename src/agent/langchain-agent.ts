import { createAgent, createMiddleware } from "langchain";
import {
  createSummarizationMiddleware,
  createSkillsMiddleware,
  createMemoryMiddleware,
  createPatchToolCallsMiddleware,
  StateBackend,
} from "deepagents";
import type { DynamicStructuredTool } from "langchain";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";

import { LoggerService } from "../services/logger.service.js";
import { createChatModel } from "../services/langchain-model.service.js";
import type { IAiConfig } from "../shared/types/config.types.js";
import type { IChatImageAttachment, IToolCallSummary } from "./types.js";
import { ReasoningParserService } from "../services/providers/reasoning/reasoning-parser.service.js";
import { ReasoningNormalizerService } from "../services/providers/reasoning/reasoning-normalizer.service.js";

//#region Interfaces

export interface ILangchainAgentConfig {
  aiConfig: IAiConfig;
  systemPrompt: string;
  tools: DynamicStructuredTool[];
  checkpointer?: SqliteSaver;
  skillSources?: string[];
  memorySources?: string[];
}

export interface ILangchainAgentResult {
  text: string;
  stepsCount: number;
  sendMessageUsed?: boolean;
}

//#endregion Interfaces

//#region Public Functions

export function createLangchainAgent(config: ILangchainAgentConfig): ReturnType<typeof createAgent> {
  const model: ChatOpenAI = createChatModel(config.aiConfig);
  const logger: LoggerService = LoggerService.getInstance();

  logger.info("Creating LangChain agent", {
    toolCount: config.tools.length,
    toolNames: config.tools.map((t) => t.name),
    skillSources: config.skillSources?.length ?? 0,
    memorySources: config.memorySources?.length ?? 0,
  });

  const backendFactory = (stateAndStore: { state: unknown }) => new StateBackend(stateAndStore);

  const summarizationMiddleware = createSummarizationMiddleware({
    model,
    backend: backendFactory,
    trigger: { type: "fraction", value: 0.75 },
    keep: { type: "fraction", value: 0.40 },
  });

  const middleware = [
    summarizationMiddleware,
    createPatchToolCallsMiddleware(),
    createMiddleware({
      name: "RawResponseLogger",
      afterModel: async (state) => {
        const messages = state.messages as BaseMessage[];
        const lastMsg = messages?.[messages.length - 1];
        if (lastMsg && AIMessage.isInstance(lastMsg)) {
          const reasoningContent = lastMsg.additional_kwargs?.reasoning_content as string | undefined;
          logger.info("[RAW LLM RESPONSE]", {
            type: lastMsg._getType(),
            contentType: typeof lastMsg.content,
            isArray: Array.isArray(lastMsg.content),
            content: typeof lastMsg.content === "string" 
              ? lastMsg.content.slice(0, 1000) 
              : JSON.stringify(lastMsg.content).slice(0, 1000),
            reasoningContent: reasoningContent ? reasoningContent.slice(0, 500) : undefined,
            toolCalls: lastMsg.tool_calls?.map((tc) => ({
              name: tc.name,
              id: tc.id,
              argsPreview: JSON.stringify(tc.args).slice(0, 200),
            })) ?? [],
            additionalKwargs: Object.keys(lastMsg.additional_kwargs ?? {}),
          });
        }
        return state;
      },
    }),
  ] as unknown[];

  if (config.skillSources && config.skillSources.length > 0) {
    middleware.push(
      createSkillsMiddleware({
        backend: backendFactory,
        sources: config.skillSources,
      })
    );
  }

  if (config.memorySources && config.memorySources.length > 0) {
    middleware.push(
      createMemoryMiddleware({
        backend: backendFactory,
        sources: config.memorySources,
      })
    );
  }

  return createAgent({
    model,
    systemPrompt: config.systemPrompt,
    tools: config.tools,
    middleware: middleware as [],
    checkpointer: config.checkpointer,
  }).withConfig({
    recursionLimit: 10000,
  });
}

export function buildHumanMessage(
  text: string,
  images?: IChatImageAttachment[],
): HumanMessage {
  if (!images || images.length === 0) {
    return new HumanMessage({ content: text });
  }

  const contentParts: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    { type: "text", text },
  ];

  for (const image of images) {
    const base64: string = image.imageBuffer.toString("base64");
    contentParts.push({
      type: "image_url",
      image_url: {
        url: `data:${image.mediaType};base64,${base64}`,
      },
    });
  }

  return new HumanMessage({ content: contentParts });
}

export async function invokeAgentAsync(
  agent: ReturnType<typeof createLangchainAgent>,
  text: string,
  threadId: string,
  images?: IChatImageAttachment[],
  onStepAsync?: (stepNumber: number, toolCalls: IToolCallSummary[]) => Promise<void>,
): Promise<ILangchainAgentResult> {
  const logger: LoggerService = LoggerService.getInstance();
  const userMessage: HumanMessage = buildHumanMessage(text, images);

  let stepsCount: number = 0;
  let progressStepCount: number = 0;
  let sendMessageUsed: boolean = false;

  let stream: AsyncIterable<unknown>;
  try {
    stream = await agent.stream(
      { messages: [userMessage] },
      { configurable: { thread_id: threadId }, streamMode: ["tools", "updates"] },
    );
  } catch (error: unknown) {
    logger.error("Failed to initialize agent stream", {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  for await (const chunk of stream) {
    if (!chunk || !Array.isArray(chunk)) {
      continue;
    }

    const [mode, payload] = chunk as [string, Record<string, unknown>];

    if (mode === "tools") {
      const event = payload as { event: string; name: string; input?: unknown; toolCallId?: string; output?: unknown; error?: unknown };

      if (event.event === "on_tool_start") {
        stepsCount++;
        progressStepCount++;

        const parsedInput: Record<string, unknown> = _parseToolInput(event.input);

        const toolCall: IToolCallSummary = {
          name: event.name,
          input: parsedInput,
          toolCallId: event.toolCallId,
        };

        if (event.name === "send_message") {
          sendMessageUsed = true;
        }

        logger.logStep(stepsCount, event.name, parsedInput, "(running...)");

        if (onStepAsync) {
          await onStepAsync(progressStepCount, [toolCall]);
        }
      } else if (event.event === "on_tool_end" || event.event === "on_tool_error") {
        logger.debug(`Tool ${event.event} for ${event.name}`, {
          toolCallId: event.toolCallId,
          hasOutput: event.output !== undefined,
          hasError: event.error !== undefined,
        });
      }
    }
  }

  let messages: BaseMessage[] = [];
  try {
    const state = await agent.getState({ configurable: { thread_id: threadId } }) as { values?: { messages?: unknown } };
    messages = _coerceMessages(state.values?.messages);
  } catch (error: unknown) {
    logger.error("Failed to read final agent state", {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  logger.debug("Agent result messages", {
    messageCount: messages.length,
    messageTypes: messages.map((m: { _getType(): string }) => ({
      type: m._getType(),
      preview: JSON.stringify(m).slice(0, 200),
    })),
  });

  const responseText: string = _extractResponseTextFromMessages(messages);

  logger.logFinalResponse(responseText, {
    threadId,
    stepsCount,
    messageCount: messages.length,
    lastMessageType: messages[messages.length - 1]?._getType() ?? "none",
  });

  logger.info("Agent invocation complete", {
    threadId,
    stepsCount,
    responseLength: responseText.length,
    messageCount: messages.length,
    lastMessageType: messages[messages.length - 1]?._getType(),
    sendMessageUsed,
  });

  return {
    text: responseText,
    stepsCount,
    sendMessageUsed,
  };
}

function _parseToolInput(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null) {
    return input as Record<string, unknown>;
  }
  if (typeof input === "string") {
    try {
      return JSON.parse(input) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

function _coerceMessages(rawMessages: unknown): BaseMessage[] {
  if (!Array.isArray(rawMessages)) {
    return [];
  }

  const messages: BaseMessage[] = [];
  for (const message of rawMessages) {
    if (
      typeof message === "object" &&
      message !== null &&
      typeof (message as { _getType?: unknown })._getType === "function"
    ) {
      messages.push(message as BaseMessage);
    }
  }

  return messages;
}

function _extractResponseTextFromMessages(messages: BaseMessage[]): string {
  let responseText: string = "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg._getType() === "ai") {
      const aiMsg = msg as AIMessage;
      const content = aiMsg.content;

      if (typeof content === "string") {
        responseText = content;
      } else if (Array.isArray(content)) {
        const textBlocks = content.filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" && block !== null && block.type === "text"
        );
        responseText = textBlocks.map((b) => b.text).join("");
      }

      const additionalKwargs: Record<string, unknown> =
        (aiMsg.additional_kwargs ?? {}) as Record<string, unknown>;
      const reasoningContent: string = ReasoningParserService.extractReasoningFromAdditionalKwargs(additionalKwargs);
      const normalized = ReasoningNormalizerService.normalize({
        content: responseText,
        reasoningContent,
      });

      responseText = normalized.text;

      if (responseText.length > 0) {
        break;
      }
    }
  }

  return responseText;
}

//#endregion Public Functions
