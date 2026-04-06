import type { IToolCallSummary } from "../../agent/types.js";
import { escapeTelegramHtml, formatStepTraceLines } from "./telegram-formatters.js";

export class TelegramProgressTracker {
  private readonly _stepLogs: string[] = [];

  public appendStep(stepNumber: number, toolCalls: IToolCallSummary[]): void {
    const traceLine: string | null = formatStepTraceLines(stepNumber, toolCalls);
    if (traceLine) {
      this._stepLogs.push(traceLine);
    }
  }

  public buildProgressText(status: string): string {
    if (this._stepLogs.length === 0) {
      return status;
    }
    const escapedStepLogs: string = this._stepLogs
      .map((line: string): string => escapeTelegramHtml(line))
      .join("\n");
    return `${status}\n\n<blockquote expandable>${escapedStepLogs}</blockquote>`;
  }

  public getStepLogCount(): number {
    return this._stepLogs.length;
  }

  public hasTrace(): boolean {
    return this._stepLogs.length > 0;
  }
}
