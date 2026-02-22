import {
  Component,
  ChangeDetectionStrategy,
  inject,
  OnDestroy,
  computed,
  signal,
  effect,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import type { GraphUpdatedEvent, INode, INodeTestCase, INodeTestResult, IStatusState } from "../../models/brain.types";
import { BrainSocketService } from "../../services/brain-socket.service";

@Component({
  selector: "app-graph",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./graph.html",
  styleUrl: "./graph.scss",
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GraphComponent implements OnDestroy {
  //#region Data members

  private _socket = inject(BrainSocketService);

  private readonly _NodeWidth = 280;
  private readonly _NodeHeight = 150;
  private readonly _HGap = 80;
  private readonly _VGap = 40;

  //#endregion Data members

  //#region Public members

  protected readonly jobs = this._socket.jobs;
  protected readonly selectedJobId = this._socket.lastJobId;
  protected readonly graph = this._socket.graph;
  protected readonly currentJobId = this._socket.lastJobId;
  protected readonly isExecuting = this._socket.isExecuting;
  protected readonly status = this._socket.status;

  // Extract context tokens from status (persists even when status clears)
  protected readonly contextTokens = computed((): number => {
    const s = this.status();
    return s?.contextTokens ?? 0;
  });

  // Test-related signals
  protected readonly nodeTests = signal<Map<string, INodeTestCase[]>>(new Map());
  protected readonly selectedNodeTests = signal<INodeTestCase[]>([]);
  protected readonly selectedNodeForTests = signal<INode | null>(null);
  protected readonly testResults = signal<Map<string, INodeTestResult>>(new Map());
  protected readonly isRunningTest = signal<string | null>(null);
  protected readonly showTestPanel = signal(false);

  protected readonly nodePositions = computed((): Map<string, { x: number; y: number }> => {
    const graphData = this.graph();
    if (!graphData || graphData.nodes.length === 0) return new Map();
    return this._computeNodePositions(graphData.nodes, graphData.entrypointNodeId);
  });

  protected readonly canvasWidth = computed((): number => {
    const positions = this.nodePositions();
    if (positions.size === 0) return 800;
    let maxX: number = 0;
    for (const pos of positions.values()) maxX = Math.max(maxX, pos.x + this._NodeWidth);
    return maxX + 60;
  });

  protected readonly canvasHeight = computed((): number => {
    const positions = this.nodePositions();
    if (positions.size === 0) return 400;
    let maxY: number = 0;
    for (const pos of positions.values()) maxY = Math.max(maxY, pos.y + this._NodeHeight);
    return maxY + 60;
  });

  // Computed signal for node test counts
  protected readonly nodeTestCounts = computed((): Map<string, number> => {
    const tests = this.nodeTests();
    const counts = new Map<string, number>();
    for (const [nodeId, nodeTests] of tests) {
      counts.set(nodeId, nodeTests.length);
    }
    return counts;
  });

  //#endregion Public members

  //#region Constructor

  public constructor() {
    // Load tests when graph changes
    effect(() => {
      const graphData = this.graph();
      const jobId = this.currentJobId();

      if (graphData && jobId) {
        this._loadTestsForJobAsync(jobId);
      }
    });
  }

  //#endregion Constructor

  //#region Angular Lifecycle

  public ngOnDestroy(): void {
    // No cleanup needed for static view
  }

  //#endregion Angular Lifecycle

  //#region Public methods

  protected async onSelectJobAsync(jobId: string): Promise<void> {
    await this._socket.loadJobAsync(jobId);
  }

  protected async runCurrentJobAsync(): Promise<void> {
    const jobId: string | null = this.currentJobId();

    if (!jobId) {
      return;
    }

    await this._socket.runJobAsync(jobId);
  }

  protected getNodePos(nodeId: string): { x: number; y: number } {
    return this.nodePositions().get(nodeId) ?? { x: 0, y: 0 };
  }

  protected getArrowPath(sourceId: string, targetId: string): string {
    const src = this.nodePositions().get(sourceId);
    const tgt = this.nodePositions().get(targetId);
    if (!src || !tgt) return '';
    const x1: number = src.x + this._NodeWidth;
    const y1: number = src.y + this._NodeHeight / 2;
    const x2: number = tgt.x;
    const y2: number = tgt.y + this._NodeHeight / 2;
    const offset: number = Math.max(Math.abs(x2 - x1) * 0.5, 60);
    return `M ${x1},${y1} C ${x1 + offset},${y1} ${x2 - offset},${y2} ${x2},${y2}`;
  }

  protected isEntrypoint(node: INode, graphData: GraphUpdatedEvent): boolean {
    return node.nodeId === graphData.entrypointNodeId;
  }

  protected isActive(node: INode, graphData: GraphUpdatedEvent): boolean {
    return (
      node.nodeId === graphData.activeNodeId ||
      graphData.nodeStatuses?.[node.nodeId] === "executing"
    );
  }

  protected getNodeStatusClass(node: INode, graphData: GraphUpdatedEvent): string {
    const status: string | undefined = graphData.nodeStatuses?.[node.nodeId];

    if (!status) {
      return "";
    }

    switch (status) {
      case "executing":
        return "status-executing";
      case "completed":
        return "status-completed";
      case "failed":
        return "status-failed";
      default:
        return "";
    }
  }

  protected getTestCount(nodeId: string): number {
    return this.nodeTestCounts().get(nodeId) ?? 0;
  }

  protected hasTests(nodeId: string): boolean {
    return this.getTestCount(nodeId) > 0;
  }

  protected async openTestPanelAsync(node: INode): Promise<void> {
    const jobId = this.currentJobId();
    if (!jobId) return;

    const tests = await this._socket.getNodeTestsAsync(jobId, node.nodeId);
    this.selectedNodeTests.set(tests);
    this.selectedNodeForTests.set(node);
    this.showTestPanel.set(true);
  }

  protected closeTestPanel(): void {
    this.showTestPanel.set(false);
    this.selectedNodeTests.set([]);
    this.selectedNodeForTests.set(null);
  }

  protected async runTestAsync(test: INodeTestCase): Promise<void> {
    const jobId = this.currentJobId();
    if (!jobId) return;

    this.isRunningTest.set(test.testId);

    try {
      const result = await this._socket.runNodeTestAsync(test.testId, jobId, test.nodeId);

      if (result) {
        const results = this.testResults();
        results.set(test.testId, result);
        this.testResults.set(new Map(results));
      }
    } finally {
      this.isRunningTest.set(null);
    }
  }

  protected getTestResult(testId: string): INodeTestResult | undefined {
    return this.testResults().get(testId);
  }

  protected formatSchema(schema: Record<string, unknown> | string): string {
    if (!schema) {
      return "None";
    }

    let parsedSchema: Record<string, unknown>;

    if (typeof schema === "string") {
      try {
        parsedSchema = JSON.parse(schema);
      } catch {
        return "Invalid JSON";
      }
    } else {
      parsedSchema = schema;
    }

    if (Object.keys(parsedSchema).length === 0) {
      return "None";
    }

    // Extract actual properties if it's a JSON schema wrapper
    const properties = (parsedSchema["properties"] as Record<string, unknown>) ?? parsedSchema;

    if (Object.keys(properties).length === 0) {
      return "None";
    }

    const props = Object.entries(properties)
      .filter(([key]) => key !== "type" || properties[key] !== "object")
      .map(([key, value]) => {
        let typeStr = "unknown";

        if (typeof value === "object" && value !== null) {
          const valObj = value as Record<string, unknown>;
          if (valObj["type"] === "array" && valObj["items"]) {
             typeStr = "array";
          } else {
             typeStr = (valObj["type"] as string) ?? typeof value;
          }
        } else {
          typeStr = typeof value;
        }

        return `${key}: ${typeStr}`;
      });

    return props.join(", ") || "None";
  }

  protected formatJson(data: unknown): string {
    try {
      return JSON.stringify(data, null, 2);
    } catch {
      return String(data);
    }
  }

  protected formatStatus(status: IStatusState): string {
    const typeLabels: Record<string, string> = {
      llm_request: "🤖 LLM",
      embedding: "📊 Embedding",
      job_execution: "⚙️ Job",
      skill_setup: "🔧 Skill",
      tool_execution: "🛠️ Tool",
      web_search: "🔍 Search",
      web_crawl: "🕷️ Crawl",
      http_request: "🌐 HTTP",
      idle: "💤 Idle",
    };

    const label = typeLabels[status.type] ?? status.type;
    const elapsed = Math.floor((Date.now() - status.startedAt) / 1000);
    let message = `${label}: ${status.message}`;

    if (status.inputTokens !== undefined) {
      message += ` (${status.inputTokens.toLocaleString()} input tokens)`;
    }

    message += ` (${elapsed}s)`;

    if (status.contextTokens !== undefined && status.contextTokens > 0) {
      message += ` [${status.contextTokens.toLocaleString()} context]`;
    }

    return message;
  }

  //#endregion Public methods

  //#region Private methods

  private async _loadTestsForJobAsync(jobId: string): Promise<void> {
    try {
      const tests = await this._socket.getNodeTestsAsync(jobId);

      const testMap = new Map<string, INodeTestCase[]>();

      for (const test of tests) {
        const existing = testMap.get(test.nodeId) ?? [];
        existing.push(test);
        testMap.set(test.nodeId, existing);
      }

      this.nodeTests.set(testMap);
    } catch (error) {
      console.error("Failed to load tests:", error);
    }
  }

  private _computeNodePositions(nodes: INode[], entrypointId: string | null): Map<string, { x: number; y: number }> {
    const levels = new Map<string, number>();
    const entryId: string | undefined = entrypointId ?? nodes[0]?.nodeId;
    if (!entryId) return new Map();

    const queue: string[] = [entryId];
    levels.set(entryId, 0);

    while (queue.length > 0) {
      const nodeId = queue.shift()!;
      const node = nodes.find((n: INode): boolean => n.nodeId === nodeId);
      const level = levels.get(nodeId)!;
      for (const connId of (node?.connections ?? [])) {
        if (!levels.has(connId)) {
          levels.set(connId, level + 1);
          queue.push(connId);
        }
      }
    }

    // Any unreachable node gets a level after the max
    const maxLevel: number = levels.size > 0 ? Math.max(...levels.values()) : 0;
    let extraLevel: number = maxLevel + 1;
    for (const node of nodes) {
      if (!levels.has(node.nodeId)) {
        levels.set(node.nodeId, extraLevel++);
      }
    }

    // Assign rows within each level (in order of appearance in nodes array)
    const levelRows = new Map<number, number>();
    const positions = new Map<string, { x: number; y: number }>();

    for (const node of nodes) {
      const level = levels.get(node.nodeId)!;
      const row = levelRows.get(level) ?? 0;
      levelRows.set(level, row + 1);
      positions.set(node.nodeId, {
        x: level * (this._NodeWidth + this._HGap) + 40,
        y: row * (this._NodeHeight + this._VGap) + 40,
      });
    }

    return positions;
  }

  //#endregion Private methods
}
