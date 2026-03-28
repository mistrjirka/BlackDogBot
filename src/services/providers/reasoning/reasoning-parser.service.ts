import type { IAnswerExtractionResult, IThinkParseResult } from "./reasoning.types.js";

export interface IParsedTextToolCall {
  name: string;
  arguments: string;
}

export class ReasoningParserService {
  public static normalizeToolArguments(argumentsUnknown: unknown): string {
    if (typeof argumentsUnknown === "string") {
      return argumentsUnknown;
    }

    if (typeof argumentsUnknown === "object" && argumentsUnknown !== null) {
      return JSON.stringify(argumentsUnknown);
    }

    return "{}";
  }

  public static parseToolCallsFromText(content: string): IParsedTextToolCall[] {
    if (content.trim().length === 0) {
      return [];
    }

    const parsedToolCalls: IParsedTextToolCall[] = [];
    const toolCallRegex: RegExp = /<(tool_call|toolcall)>([\s\S]*?)<\/\1>/gi;
    const blocks: RegExpMatchArray[] = Array.from(content.matchAll(toolCallRegex));

    for (const block of blocks) {
      const blockContent: string = (block[2] ?? "").trim();
      if (blockContent.length === 0) {
        continue;
      }

      const parsedFromJsonEnvelope: IParsedTextToolCall | null = this._parseJsonToolCallEnvelope(blockContent);
      if (parsedFromJsonEnvelope !== null) {
        parsedToolCalls.push(parsedFromJsonEnvelope);
        continue;
      }

      const parsedFromFunctionEnvelope: IParsedTextToolCall | null = this._parseFunctionEnvelope(blockContent);
      if (parsedFromFunctionEnvelope !== null) {
        parsedToolCalls.push(parsedFromFunctionEnvelope);
      }
    }

    const deduped: IParsedTextToolCall[] = [];
    const seenKeys: Set<string> = new Set<string>();

    for (const parsedToolCall of parsedToolCalls) {
      const dedupeKey: string = `${parsedToolCall.name}::${parsedToolCall.arguments}`;
      if (seenKeys.has(dedupeKey)) {
        continue;
      }
      seenKeys.add(dedupeKey);
      deduped.push(parsedToolCall);
    }

    return deduped;
  }

  public static parseThinkTags(content: string): IThinkParseResult {
    const thinkTagRegex: RegExp = /<think>([\s\S]*?)<\/think>/gi;
    const matches: RegExpMatchArray[] = Array.from(content.matchAll(thinkTagRegex));

    if (matches.length > 0) {
      const reasoningParts: string[] = matches
        .map((match: RegExpMatchArray): string => (match[1] ?? "").trim())
        .filter((part: string): boolean => part.length > 0);

      const cleanedContent: string = content
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .trim();

      return {
        reasoning: reasoningParts.length > 0 ? reasoningParts.join("\n\n") : null,
        cleanedContent,
      };
    }

    const closingTag: string = "</think>";
    const closingIndex: number = content.indexOf(closingTag);

    if (closingIndex !== -1) {
      const reasoning: string = content.slice(0, closingIndex).trim();
      const cleanedContent: string = content.slice(closingIndex + closingTag.length).trim();
      return {
        reasoning: reasoning.length > 0 ? reasoning : null,
        cleanedContent,
      };
    }

    return {
      reasoning: null,
      cleanedContent: content,
    };
  }

  public static extractAnswerFromReasoning(reasoning: string): IAnswerExtractionResult {
    if (!reasoning || reasoning.length === 0) {
      return { answer: "", method: "none" };
    }

    const lines: string[] = reasoning.split("\n");
    const contentLines: string[] = [];
    let inAnswerSection: boolean = false;

    for (const line of lines) {
      const trimmed: string = line.trim();

      if (
        trimmed.includes("**Answer**") ||
        trimmed.includes("**Final Answer**") ||
        trimmed.includes("**Response**")
      ) {
        inAnswerSection = true;
        continue;
      }

      if (inAnswerSection) {
        if (trimmed.startsWith("**") && trimmed.endsWith("**")) {
          break;
        }
        if (trimmed.length > 0) {
          contentLines.push(line);
        }
      }
    }

    if (contentLines.length > 0) {
      return {
        answer: contentLines.join("\n").trim(),
        method: "answer_section",
      };
    }

    const parsed: IThinkParseResult = this.parseThinkTags(reasoning);
    if (parsed.cleanedContent.length > 0 && parsed.cleanedContent !== reasoning) {
      return {
        answer: parsed.cleanedContent,
        method: "post_think",
      };
    }

    const paragraphs: string[] = reasoning.split(/\n\s*\n/);
    for (let i = paragraphs.length - 1; i >= 0; i--) {
      const paragraph: string = paragraphs[i].trim();
      if (paragraph.length > 0 && !paragraph.startsWith("*") && !paragraph.startsWith("#")) {
        return {
          answer: paragraph,
          method: "last_paragraph",
        };
      }
    }

    return {
      answer: reasoning.trim(),
      method: "raw_reasoning",
    };
  }

  public static extractReasoningFromAdditionalKwargs(additionalKwargs: Record<string, unknown>): string {
    const parts: string[] = [];

    const reasoningContentUnknown: unknown = additionalKwargs.reasoning_content;
    if (typeof reasoningContentUnknown === "string" && reasoningContentUnknown.trim().length > 0) {
      parts.push(reasoningContentUnknown.trim());
    }

    const reasoningDetailsUnknown: unknown = additionalKwargs.reasoning_details;
    if (Array.isArray(reasoningDetailsUnknown)) {
      for (const detail of reasoningDetailsUnknown) {
        if (typeof detail !== "object" || detail === null) {
          continue;
        }

        const detailRecord: Record<string, unknown> = detail as Record<string, unknown>;
        if (typeof detailRecord.text === "string" && detailRecord.text.trim().length > 0) {
          parts.push(detailRecord.text.trim());
        }

        if (Array.isArray(detailRecord.summary)) {
          for (const summaryPart of detailRecord.summary) {
            if (typeof summaryPart === "object" && summaryPart !== null) {
              const summaryRecord: Record<string, unknown> = summaryPart as Record<string, unknown>;
              if (typeof summaryRecord.text === "string" && summaryRecord.text.trim().length > 0) {
                parts.push(summaryRecord.text.trim());
              }
            }
          }
        }
      }
    }

    return parts.join("\n\n").trim();
  }

  private static _parseJsonToolCallEnvelope(blockContent: string): IParsedTextToolCall | null {
    try {
      const parsedUnknown: unknown = JSON.parse(blockContent);
      if (typeof parsedUnknown !== "object" || parsedUnknown === null) {
        return null;
      }

      const parsedRecord: Record<string, unknown> = parsedUnknown as Record<string, unknown>;
      const nameUnknown: unknown = parsedRecord.name;

      if (typeof nameUnknown !== "string" || nameUnknown.trim().length === 0) {
        return null;
      }

      return {
        name: nameUnknown,
        arguments: this.normalizeToolArguments(parsedRecord.arguments),
      };
    } catch {
      return null;
    }
  }

  private static _parseFunctionEnvelope(blockContent: string): IParsedTextToolCall | null {
    const functionRegex: RegExp = /^<function=([^>]+)>([\s\S]*?)<\/function>$/i;
    const functionMatch: RegExpMatchArray | null = blockContent.match(functionRegex);

    if (!functionMatch) {
      return null;
    }

    const name: string = (functionMatch[1] ?? "").trim();
    const functionBody: string = (functionMatch[2] ?? "").trim();

    if (name.length === 0) {
      return null;
    }

    const parameterRegex: RegExp = /<(parameter|param)=([^>]+)>([\s\S]*?)<\/\1>/gi;
    const parameterMatches: RegExpMatchArray[] = Array.from(functionBody.matchAll(parameterRegex));

    if (parameterMatches.length > 0) {
      const parsedParameters: Record<string, unknown> = {};
      for (const parameterMatch of parameterMatches) {
        const parameterName: string = (parameterMatch[2] ?? "").trim();
        const parameterValue: string = (parameterMatch[3] ?? "").trim();

        if (parameterName.length > 0) {
          parsedParameters[parameterName] = parameterValue;
        }
      }

      return {
        name,
        arguments: this.normalizeToolArguments(parsedParameters),
      };
    }

    try {
      const parsedBodyUnknown: unknown = JSON.parse(functionBody);
      return {
        name,
        arguments: this.normalizeToolArguments(parsedBodyUnknown),
      };
    } catch {
      return null;
    }
  }
}
