import type { IAnswerExtractionResult, IThinkParseResult } from "./reasoning.types.js";

export class ReasoningParserService {
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
}
