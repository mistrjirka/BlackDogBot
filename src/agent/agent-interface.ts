import type { DynamicStructuredTool } from "langchain";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";

import type { IAiConfig } from "../shared/types/config.types.js";
import type { IChatImageAttachment, IAgentResult, IToolCallSummary } from "./types.js";
import type { MessagePlatform } from "../shared/types/messaging.types.js";
import { createLangchainAgent, invokeAgentAsync } from "./langchain-agent.js";

type MessageSender = (message: string) => Promise<string | null>;
type PhotoSender = (imageBuffer: Buffer, caption: string | null) => Promise<string | null>;
type OnStepCallback = (stepNumber: number, toolCalls: IToolCallSummary[]) => Promise<void>;

export interface IChatAgent {
  processMessageForChatAsync(
    chatId: string,
    message: string,
    images?: IChatImageAttachment[],
  ): Promise<IAgentResult>;

  initializeForChatAsync(
    chatId: string,
    messageSender: MessageSender,
    photoSender: PhotoSender,
    onStepAsync?: OnStepCallback,
    platform?: MessagePlatform,
  ): Promise<void>;

  /** Stop chat session (optional - MainAgent specific) */
  stopChat?(chatId: string): boolean;

  /** Compact session messages (optional - MainAgent specific) */
  compactSessionMessagesForChatAsync?(chatId: string): Promise<boolean>;
}

export class LangchainChatAgent implements IChatAgent {
  private _agent: ReturnType<typeof createLangchainAgent>;
  private _onStepAsync?: OnStepCallback;

  constructor(aiConfig: IAiConfig, tools: DynamicStructuredTool[], checkpointer: SqliteSaver) {
    this._agent = createLangchainAgent({ aiConfig, systemPrompt: "...", tools, checkpointer });
  }

  async processMessageForChatAsync(
    chatId: string,
    message: string,
    images?: IChatImageAttachment[],
  ): Promise<IAgentResult> {
    const result = await invokeAgentAsync(
      this._agent,
      message,
      chatId,
      images,
      this._onStepAsync,
    );
    return {
      text: result.text,
      stepsCount: result.stepsCount,
      sendMessageUsed: result.sendMessageUsed,
    };
  }

  async initializeForChatAsync(
    _chatId: string,
    _messageSender: MessageSender,
    _photoSender: PhotoSender,
    onStepAsync?: OnStepCallback,
    _platform?: MessagePlatform,
  ): Promise<void> {
    this._onStepAsync = onStepAsync;
  }
}
