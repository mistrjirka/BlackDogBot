import { createDeepAgent, type SubAgent } from "deepagents";
import type { DynamicStructuredTool } from "langchain";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type { ChatOpenAI } from "@langchain/openai";
import { HumanMessage } from "@langchain/core/messages";

import { LoggerService } from "../services/logger.service.js";
import { createChatModel } from "../services/langchain-model.service.js";
import type { IAiConfig } from "../shared/types/config.types.js";
import type { IChatImageAttachment } from "./types.js";

//#region Interfaces

export interface ILangchainAgentConfig {
  aiConfig: IAiConfig;
  systemPrompt: string;
  tools: DynamicStructuredTool[];
  subagents?: SubAgent[];
  checkpointer: SqliteSaver;
}

export interface ILangchainAgentResult {
  text: string;
  stepsCount: number;
}

//#endregion Interfaces

//#region Public Functions

export function createLangchainAgent(config: ILangchainAgentConfig): any {
  const model: ChatOpenAI = createChatModel(config.aiConfig);
  const logger: LoggerService = LoggerService.getInstance();

  logger.info("Creating DeepAgents agent", {
    toolCount: config.tools.length,
    subagentCount: config.subagents?.length ?? 0,
  });

  return createDeepAgent({
    model,
    systemPrompt: config.systemPrompt,
    tools: config.tools,
    subagents: config.subagents ?? [],
    checkpointer: config.checkpointer,
  });
}

export function buildHumanMessage(
  text: string,
  images?: IChatImageAttachment[],
): HumanMessage {
  if (!images || images.length === 0) {
    return new HumanMessage({ content: text });
  }

  const contentParts: any[] = [
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
): Promise<ILangchainAgentResult> {
  const logger: LoggerService = LoggerService.getInstance();
  const userMessage: HumanMessage = buildHumanMessage(text, images);

  const result = await agent.invoke(
    { messages: [userMessage] },
    { configurable: { thread_id: threadId } },
  );

  const lastMessage = result.messages[result.messages.length - 1];
  const responseText: string = typeof lastMessage?.content === "string"
    ? lastMessage.content
    : "";

  let stepsCount: number = 0;
  for (const msg of result.messages) {
    if (msg._getType() === "ai" && (msg as any).tool_calls?.length > 0) {
      stepsCount++;
    }
  }

  logger.info("DeepAgents agent invocation complete", {
    threadId,
    stepsCount,
    responseLength: responseText.length,
    messageCount: result.messages.length,
  });

  return {
    text: responseText,
    stepsCount,
  };
}

//#endregion Public Functions
