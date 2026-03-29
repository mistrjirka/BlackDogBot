import { ReasoningParserService } from "./reasoning-parser.service.js";
import { ReasoningRendererService } from "./reasoning-renderer.service.js";
import type {
  IReasoningNormalizationInput,
  IReasoningNormalizationResult,
  IResolvedToolCall,
} from "./reasoning.types.js";

export class ReasoningNormalizerService {
  public static normalize(input: IReasoningNormalizationInput): IReasoningNormalizationResult {
    const content: string = input.content.trim();
    const reasoningContent: string = input.reasoningContent.trim();

    if (content.length > 0 && reasoningContent.length === 0) {
      return {
        reasoning: "",
        answer: content,
        text: content,
        method: "content_only",
      };
    }

    if (content.length === 0 && reasoningContent.length === 0) {
      return {
        reasoning: "",
        answer: "",
        text: "",
        method: "none",
      };
    }

    const extracted = ReasoningParserService.extractAnswerFromReasoning(reasoningContent);
    const answer: string = content.length > 0 ? content : extracted.answer;
    const rendered: string = ReasoningRendererService.render(reasoningContent, answer);

    return {
      reasoning: reasoningContent,
      answer,
      text: rendered,
      method: content.length > 0 ? "content_only" : extracted.method,
    };
  }

  public static resolveToolCalls(
    structuredToolCalls: unknown,
    content: string,
    additionalKwargs: Record<string, unknown>,
  ): IResolvedToolCall[] {
    const resolvedFromStructured: IResolvedToolCall[] = this._resolveStructuredToolCalls(structuredToolCalls);
    if (resolvedFromStructured.length > 0) {
      return resolvedFromStructured;
    }

    const parsedFromContent = ReasoningParserService.parseToolCallsFromText(content);

    const reasoningContentUnknown: unknown = additionalKwargs.reasoning_content;
    const reasoningContent: string =
      typeof reasoningContentUnknown === "string" ? reasoningContentUnknown : "";
    const parsedFromReasoning = ReasoningParserService.parseToolCallsFromText(reasoningContent);

    const merged = [...parsedFromContent, ...parsedFromReasoning];
    const deduped: IResolvedToolCall[] = [];
    const seen: Set<string> = new Set<string>();

    for (let i = 0; i < merged.length; i++) {
      const item = merged[i];
      let parsedArgsUnknown: unknown = {};

      try {
        parsedArgsUnknown = JSON.parse(item.arguments);
      } catch {
        continue;
      }

      if (typeof parsedArgsUnknown !== "object" || parsedArgsUnknown === null) {
        continue;
      }

      const args = parsedArgsUnknown as Record<string, unknown>;
      const key = `${item.name}::${JSON.stringify(args)}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      deduped.push({
        name: item.name,
        args,
        id: `text-tool-call-${i + 1}`,
      });
    }

    return deduped;
  }

  private static _resolveStructuredToolCalls(structuredToolCalls: unknown): IResolvedToolCall[] {
    if (!Array.isArray(structuredToolCalls)) {
      return [];
    }

    const resolved: IResolvedToolCall[] = [];

    for (const toolCallUnknown of structuredToolCalls) {
      if (typeof toolCallUnknown !== "object" || toolCallUnknown === null) {
        continue;
      }

      const toolCallRecord: Record<string, unknown> = toolCallUnknown as Record<string, unknown>;
      const nameUnknown: unknown = toolCallRecord.name;
      const argsUnknown: unknown = toolCallRecord.args;
      const idUnknown: unknown = toolCallRecord.id;

      if (typeof nameUnknown !== "string" || nameUnknown.trim().length === 0) {
        continue;
      }

      if (typeof argsUnknown !== "object" || argsUnknown === null || Array.isArray(argsUnknown)) {
        continue;
      }

      resolved.push({
        name: nameUnknown,
        args: argsUnknown as Record<string, unknown>,
        id: typeof idUnknown === "string" ? idUnknown : undefined,
      });
    }

    return resolved;
  }
}
