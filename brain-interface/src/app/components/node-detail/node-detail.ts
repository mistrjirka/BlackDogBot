import {
  Component,
  ChangeDetectionStrategy,
  input,
  output,
  signal,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import type { INode, INodeTestCase, INodeTestResult } from "../../models/brain.types";

@Component({
  selector: "app-node-detail",
  standalone: true,
  imports: [CommonModule],
  templateUrl: "./node-detail.html",
  styleUrl: "./node-detail.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NodeDetailComponent {
  //#region Data members

  private readonly _expandedSections = signal<Set<string>>(new Set());

  //#endregion Data members

  //#region Public members

  public readonly node = input.required<INode>();
  public readonly testCases = input<INodeTestCase[]>([]);
  public readonly testResults = input<Map<string, INodeTestResult>>(new Map());
  public readonly isRunningTest = input<string | null>(null);
  public readonly closed = output<void>();
  public readonly runTest = output<INodeTestCase>();

  //#endregion Public members

  //#region Public methods

  protected isSectionExpanded(sectionId: string): boolean {
    return this._expandedSections().has(sectionId);
  }

  protected toggleSection(sectionId: string): void {
    const current: Set<string> = new Set(this._expandedSections());

    if (current.has(sectionId)) {
      current.delete(sectionId);
    } else {
      current.add(sectionId);
    }

    this._expandedSections.set(current);
  }

  protected getConfigEntries(config: Record<string, unknown>): Array<{ key: string; value: unknown }> {
    return Object.entries(config).map(([key, value]) => ({ key, value }));
  }

  protected formatConfigValue(value: unknown): string {
    if (value === null || value === undefined) {
      return "null";
    }

    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }

    if (Array.isArray(value)) {
      return `[${value.length} items]`;
    }

    if (typeof value === "object") {
      return `{${Object.keys(value as Record<string, unknown>).length} properties}`;
    }

    return String(value);
  }

  protected formatJson(data: unknown): string {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }

  protected getTestResult(testId: string): INodeTestResult | undefined {
    return this.testResults().get(testId);
  }

  protected onClose(): void {
    this.closed.emit();
  }

  protected onRunTest(test: INodeTestCase): void {
    this.runTest.emit(test);
  }

  //#endregion Public methods
}
