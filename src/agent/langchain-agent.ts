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

  const result = await agent.invoke(
    { messages: [userMessage] },
    { configurable: { thread_id: threadId } },
  );

  const messages = result.messages;

  logger.debug("Agent result messages", {
    messageCount: messages.length,
    messageTypes: messages.map((m: { _getType(): string }) => ({
      type: m._getType(),
      preview: JSON.stringify(m).slice(0, 200),
    })),
  });

  // Find the last AI message with normalized text content
  let responseText: string = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg._getType() === "ai") {
      const aiMsg = msg as AIMessage;
      const content = aiMsg.content;

      logger.debug("Checking AI message for text", {
        index: i,
        contentType: typeof content,
        isArray: Array.isArray(content),
        contentPreview: JSON.stringify(content).slice(0, 300),
        toolCallsCount: aiMsg.tool_calls?.length ?? 0,
        additionalKwargs: Object.keys(aiMsg.additional_kwargs ?? {}),
      });

      // Handle both string content and structured content
      if (typeof content === "string") {
        responseText = content;
      } else if (Array.isArray(content)) {
        // Extract text from content blocks
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

      logger.debug("Reasoning normalization", {
        index: i,
        method: normalized.method,
        reasoningLength: normalized.reasoning.length,
        answerLength: normalized.answer.length,
        textLength: normalized.text.length,
      });

      responseText = normalized.text;

      if (responseText.length > 0) {
        break;
      }
    }
  }

  let stepsCount: number = 0;
  let progressStepCount: number = 0;
  const toolCalls: Array<{ name: string; args: Record<string, unknown>; id?: string }> = [];
  let sendMessageUsed: boolean = false;

  // Log each tool step with colored formatting
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg._getType() === "ai") {
      const aiMsg = msg as AIMessage;
      if (aiMsg.tool_calls && aiMsg.tool_calls.length > 0) {
        progressStepCount++;
        const stepToolCalls: IToolCallSummary[] = [];

        for (const tc of aiMsg.tool_calls) {
          toolCalls.push({
            name: tc.name,
            args: tc.args as Record<string, unknown>,
            id: tc.id,
          });

          stepToolCalls.push({
            name: tc.name,
            input: tc.args as Record<string, unknown>,
            toolCallId: tc.id,
          });

          if (tc.name === "send_message") {
            sendMessageUsed = true;
          }

          stepsCount++;

          // Find the corresponding tool result message (prefer tool_call_id for correctness).
          const toolResultMsg = messages.find((m: {
            _getType(): string;
            name?: string;
            tool_call_id?: string;
          }): boolean => {
            if (m._getType() !== "tool") {
              return false;
            }

            if (tc.id && m.tool_call_id) {
              return m.tool_call_id === tc.id;
            }

            return m.name === tc.name;
          });

          let resultPreview = "";
          if (toolResultMsg) {
            const toolContent = (toolResultMsg as { content?: unknown }).content;
            if (typeof toolContent === "string") {
              resultPreview = toolContent.slice(0, 500);
            } else if (Array.isArray(toolContent)) {
              resultPreview = toolContent
                .map((c) => (typeof c === "string" ? c : JSON.stringify(c)))
                .join("")
                .slice(0, 500);
            } else {
              resultPreview = JSON.stringify(toolContent).slice(0, 500);
            }
          }

          // Log step with colored formatting
          logger.logStep(
            stepsCount,
            tc.name,
            tc.args as Record<string, unknown>,
            resultPreview,
          );
        }

        // Invoke the onStepAsync callback for live progress updates
        if (onStepAsync && stepToolCalls.length > 0) {
          await onStepAsync(progressStepCount, stepToolCalls);
        }
      }
    }
  }

  // Always log the final response (including empty), so termination is visible.
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

//#endregion Public Functions
