/**
 * Agent types extracted from deprecated agent files.
 * These types are used by platform handlers and must not depend on 'ai' package.
 * @phase4-extracted - Used by handlers after Vercel AI SDK removal.
 */

export interface IAgentResult {
  text: string;
  stepsCount: number;
  paused?: boolean;
}

export interface IToolCallSummary {
  name: string;
  input: Record<string, unknown>;
  toolCallId?: string;
  result?: unknown;
  isError?: boolean;
}

export type OnStepCallback = (
  stepNumber: number,
  toolCalls: IToolCallSummary[],
) => Promise<void>;

export type PhotoSender = (photo: Buffer, caption?: string) => Promise<void>;

export interface IChatImageAttachment {
  imageBuffer: Buffer;
  mediaType: string;
}