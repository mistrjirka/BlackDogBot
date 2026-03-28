export type ReasoningAnswerMethod =
  | "answer_section"
  | "post_think"
  | "last_paragraph"
  | "raw_reasoning"
  | "content_only"
  | "none";

export interface IAnswerExtractionResult {
  answer: string;
  method: ReasoningAnswerMethod;
}

export interface IThinkParseResult {
  reasoning: string | null;
  cleanedContent: string;
}

export interface IReasoningNormalizationInput {
  content: string;
  reasoningContent: string;
}

export interface IReasoningNormalizationResult {
  reasoning: string;
  answer: string;
  text: string;
  method: ReasoningAnswerMethod;
}

export interface IResolvedToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}
