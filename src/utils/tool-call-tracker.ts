import type { ModelMessage } from "ai";

export interface ITrackedToolCallSummary {
  name: string;
  input: Record<string, unknown>;
  toolCallId?: string;
  result?: unknown;
  isError?: boolean;
}

export function extractLastAssistantToolCalls(messages: ModelMessage[]): ITrackedToolCallSummary[] {
  for (let i: number = messages.length - 1; i >= 0; i--) {
    const message: ModelMessage = messages[i];

    if (message.role === "assistant" && Array.isArray(message.content)) {
      const calls: ITrackedToolCallSummary[] = [];

      for (const part of message.content) {
        if (
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          (part as { type: string }).type === "tool-call" &&
          "toolName" in part &&
          typeof (part as { toolName: unknown }).toolName === "string"
        ) {
          calls.push({
            toolCallId: (part as { toolCallId?: string }).toolCallId,
            name: (part as { toolName: string }).toolName,
            input: ((part as { args?: unknown }).args ?? (part as { input?: unknown }).input ?? {}) as Record<string, unknown>,
          });
        }
      }

      if (calls.length > 0) {
        for (let j: number = i + 1; j < messages.length; j++) {
          const nextMessage: ModelMessage = messages[j];
          if (nextMessage.role === "tool" && Array.isArray(nextMessage.content)) {
            for (const nextPart of nextMessage.content) {
              if (
                typeof nextPart === "object" &&
                nextPart !== null &&
                "type" in nextPart &&
                (nextPart as { type: string }).type === "tool-result"
              ) {
                const resultPart = nextPart as {
                  toolCallId?: string;
                  toolName?: string;
                  result?: unknown;
                  output?: unknown;
                  isError?: boolean;
                };

                let actualResult: unknown = resultPart.result;
                if (actualResult === undefined && resultPart.output !== undefined) {
                  const outputObject = resultPart.output as { type?: string; value?: unknown };
                  if (outputObject && typeof outputObject === "object" && outputObject.value !== undefined) {
                    actualResult = outputObject.value;
                  } else {
                    actualResult = resultPart.output;
                  }
                }

                const matchedById = calls.find((call) => call.toolCallId === resultPart.toolCallId);
                if (matchedById) {
                  matchedById.result = actualResult ?? null;
                  matchedById.isError = resultPart.isError;
                  continue;
                }

                const matchedByName = calls.find((call) => call.name === resultPart.toolName && call.result === undefined);
                if (matchedByName) {
                  matchedByName.result = actualResult ?? null;
                  matchedByName.isError = resultPart.isError;
                }
              }
            }
          }
        }

        return calls;
      }
    }
  }

  return [];
}
