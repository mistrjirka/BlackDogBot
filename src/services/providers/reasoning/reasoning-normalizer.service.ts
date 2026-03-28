import { ReasoningParserService } from "./reasoning-parser.service.js";
import { ReasoningRendererService } from "./reasoning-renderer.service.js";
import type {
  IReasoningNormalizationInput,
  IReasoningNormalizationResult,
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
}
