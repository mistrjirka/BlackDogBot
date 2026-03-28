export class ReasoningRendererService {
  public static render(reasoning: string, answer: string): string {
    const trimmedReasoning: string = reasoning.trim();
    const trimmedAnswer: string = answer.trim();

    if (trimmedReasoning.length === 0) {
      return trimmedAnswer;
    }

    if (trimmedAnswer.length === 0) {
      return this._toBlockQuote(trimmedReasoning);
    }

    return `${this._toBlockQuote(trimmedReasoning)}\n\n${trimmedAnswer}`;
  }

  private static _toBlockQuote(text: string): string {
    return text
      .split("\n")
      .map((line: string): string => `> ${line}`)
      .join("\n");
  }
}
