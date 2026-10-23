export interface ILlmToolCallFunction {
  name?: string;
  arguments?: string;
}

export interface ILlmToolCall {
  function?: ILlmToolCallFunction;
}

export interface ILlmMessage {
  content?: string;
  reasoning_content?: string;
  tool_calls?: ILlmToolCall[];
}

export interface ILlmChoice {
  finish_reason?: string | null;
  message?: ILlmMessage;
}

export interface ILlmResponse {
  choices?: ILlmChoice[];
}
