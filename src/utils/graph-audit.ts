import { z } from "zod";
import type { IJob, INode } from "../shared/types/index.js";
import { generateObjectWithRetryAsync } from "./llm-retry.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import { PromptService } from "../services/prompt.service.js";
import { buildAsciiGraph } from "./ascii-graph.js";

//#region Interfaces

export interface IGraphAuditResult {
  approved: boolean;
  issues: string[];
  suggestions: string[];
}

export interface IJobContext {
  jobName: string;
  jobDescription: string;
}

//#endregion Interfaces

//#region Constants

const GraphAuditResultSchema: z.ZodType<IGraphAuditResult> = z.object({
  approved: z.boolean(),
  issues: z.array(z.string()),
  suggestions: z.array(z.string()),
});

//#endregion Constants

//#region Public functions

/**
 * Renders a graph to a readable text format for LLM analysis.
 * Includes job metadata, node details, ASCII visualization, and potential issues.
 */
export function renderGraphForAudit(job: IJob, nodes: INode[]): string {
  const sections: string[] = [];

  // Job metadata
  sections.push("# Job Metadata");
  sections.push(`Name: ${job.name}`);
  sections.push(`Description: ${job.description}`);
  sections.push(`Status: ${job.status}`);
  sections.push(`Entrypoint: ${job.entrypointNodeId ?? "(none)"}`);
  sections.push("");

  // Node list with details
  sections.push("# Nodes");
  sections.push("");

  const nodeMap: Map<string, INode> = new Map<string, INode>(
    nodes.map((n: INode) => [n.nodeId, n]),
  );

  // Build parent map for fan-in detection
  const parents: Map<string, string[]> = new Map<string, string[]>(
    nodes.map((n: INode) => [n.nodeId, []]),
  );

  for (const node of nodes) {
    for (const targetId of node.connections) {
      const targetParents: string[] = parents.get(targetId) ?? [];
      targetParents.push(node.nodeId);
      parents.set(targetId, targetParents);
    }
  }

  for (const node of nodes) {
    const isEntrypoint: boolean = node.nodeId === job.entrypointNodeId;
    const nodeParents: string[] = parents.get(node.nodeId) ?? [];
    const hasFanIn: boolean = nodeParents.length > 1;

    sections.push(`## ${node.name}${isEntrypoint ? " (entrypoint)" : ""}`);
    sections.push(`- Type: ${node.type}`);
    sections.push(`- ID: ${node.nodeId}`);
    sections.push(`- Description: ${node.description}`);

    // Config summary
    const configSummary: string = _summarizeConfig(
      node.type,
      node.config as Record<string, unknown>,
    );
    sections.push(`- Config: ${configSummary}`);

    // Input schema summary
    const inputSummary: string = _summarizeSchema(node.inputSchema);
    sections.push(`- Input Schema: ${inputSummary}`);

    // Output schema summary
    const outputSummary: string = _summarizeSchema(node.outputSchema);
    sections.push(`- Output Schema: ${outputSummary}`);

    // Connections
    if (node.connections.length > 0) {
      const connectionNames: string[] = node.connections.map(
        (id: string) => nodeMap.get(id)?.name ?? id,
      );
      sections.push(`- Connects to: ${connectionNames.join(", ")}`);
    } else {
      sections.push(`- Connects to: (none - terminal node)`);
    }

    // Fan-in warning
    if (hasFanIn) {
      const parentNames: string[] = nodeParents.map(
        (id: string) => nodeMap.get(id)?.name ?? id,
      );
      sections.push(`- **FAN-IN WARNING**: This node has ${nodeParents.length} parents: ${parentNames.join(", ")}`);
    }

    sections.push("");
  }

  // ASCII graph visualization
  sections.push("# Graph Visualization");
  sections.push("");
  sections.push(buildAsciiGraph(nodes, job.entrypointNodeId));
  sections.push("");

  // Potential issues
  sections.push("# Potential Issues");
  sections.push("");

  const issues: string[] = [];

  // Check for fan-in nodes
  for (const [nodeId, nodeParents] of parents) {
    if (nodeParents.length > 1) {
      const node: INode | undefined = nodeMap.get(nodeId);
      const parentNames: string[] = nodeParents.map(
        (id: string) => nodeMap.get(id)?.name ?? id,
      );
      issues.push(
        `- Fan-in: "${node?.name ?? nodeId}" receives data from ${nodeParents.length} nodes: ${parentNames.join(", ")}`,
      );
    }
  }

  // Check for disconnected nodes
  const reachableNodes: Set<string> = new Set<string>();

  if (job.entrypointNodeId !== null && nodeMap.has(job.entrypointNodeId)) {
    const stack: string[] = [job.entrypointNodeId];

    while (stack.length > 0) {
      const current: string = stack.pop()!;
      if (reachableNodes.has(current)) {
        continue;
      }
      reachableNodes.add(current);

      const node: INode | undefined = nodeMap.get(current);
      if (node) {
        for (const childId of node.connections) {
          if (!reachableNodes.has(childId)) {
            stack.push(childId);
          }
        }
      }
    }
  }

  for (const node of nodes) {
    if (!reachableNodes.has(node.nodeId)) {
      issues.push(`- Unreachable: "${node.name}" is not reachable from the entrypoint`);
    }
  }

  // Check for nodes with no connections (dead ends)
  for (const node of nodes) {
    if (node.connections.length === 0 && node.nodeId !== job.entrypointNodeId) {
      issues.push(`- Dead end: "${node.name}" has no outgoing connections`);
    }
  }

  // Check for missing entrypoint
  if (job.entrypointNodeId === null) {
    issues.push("- No entrypoint: Job has no entrypoint node defined");
  } else if (!nodeMap.has(job.entrypointNodeId)) {
    issues.push(`- Invalid entrypoint: Entrypoint node "${job.entrypointNodeId}" does not exist`);
  }

  if (issues.length === 0) {
    sections.push("(No structural issues detected)");
  } else {
    sections.push(...issues);
  }

  sections.push("");

  return sections.join("\n");
}

/**
 * Sends a graph description to an LLM for semantic validation.
 * Returns structured audit results with approval status, issues, and suggestions.
 */
export async function auditGraphWithLLM(
  graphDescription: string,
  jobContext: IJobContext,
): Promise<IGraphAuditResult> {
  const promptService: PromptService = PromptService.getInstance();
  const aiProviderService: AiProviderService = AiProviderService.getInstance();

  const systemPrompt: string = await promptService.getPromptAsync("graph-audit");

  const userPrompt: string = `Please audit the following job graph:

Job Name: ${jobContext.jobName}
Job Description: ${jobContext.jobDescription}

${graphDescription}

Provide your audit results in the specified JSON format.`;

  const result = await generateObjectWithRetryAsync({
    model: aiProviderService.getDefaultModel(),
    prompt: userPrompt,
    schema: GraphAuditResultSchema,
    system: systemPrompt,
  });

  // Ensure rejected graphs always have at least one issue
  // (LLM can return { approved: false, issues: [] } which is inconsistent)
  if (!result.object.approved && result.object.issues.length === 0) {
    result.object.issues.push("Graph was not approved but no specific issues were provided");
  }

  return result.object;
}

//#endregion Public functions

//#region Private functions

/**
 * Summarizes a node's configuration for display.
 */
function _summarizeConfig(
  type: string,
  config: Record<string, unknown> | undefined,
): string {
  if (!config) {
    return "(default)";
  }
  if (!config || Object.keys(config).length === 0) {
    return "(default)";
  }

  const parts: string[] = [];

  switch (type) {
    case "curl_fetcher": {
      const cfg = config as { url?: string; method?: string };
      if (cfg.url) {
        parts.push(`url=${cfg.url}`);
      }
      if (cfg.method) {
        parts.push(`method=${cfg.method}`);
      }
      break;
    }
    case "crawl4ai": {
      const cfg = config as { url?: string; extractionPrompt?: string };
      if (cfg.url) {
        parts.push(`url=${cfg.url}`);
      }
      if (cfg.extractionPrompt) {
        parts.push("has extraction prompt");
      }
      break;
    }
    case "searxng": {
      const cfg = config as { query?: string; maxResults?: number };
      if (cfg.query) {
        parts.push(`query="${cfg.query}"`);
      }
      if (cfg.maxResults) {
        parts.push(`maxResults=${cfg.maxResults}`);
      }
      break;
    }
    case "python_code": {
      const cfg = config as { code?: string };
      if (cfg.code) {
        const codePreview: string = cfg.code.length > 50
          ? cfg.code.substring(0, 50) + "..."
          : cfg.code;
        parts.push(`code="${codePreview}"`);
      }
      break;
    }
    case "output_to_ai": {
      const cfg = config as { prompt?: string; model?: string };
      if (cfg.prompt) {
        const promptPreview: string = cfg.prompt.length > 50
          ? cfg.prompt.substring(0, 50) + "..."
          : cfg.prompt;
        parts.push(`prompt="${promptPreview}"`);
      }
      if (cfg.model) {
        parts.push(`model=${cfg.model}`);
      }
      break;
    }
    case "agent": {
      const cfg = config as {
        systemPrompt?: string;
        selectedTools?: string[];
        maxSteps?: number;
      };
      if (cfg.selectedTools && cfg.selectedTools.length > 0) {
        parts.push(`tools=[${cfg.selectedTools.slice(0, 3).join(", ")}${cfg.selectedTools.length > 3 ? "..." : ""}]`);
      }
      if (cfg.maxSteps) {
        parts.push(`maxSteps=${cfg.maxSteps}`);
      }
      break;
    }
    case "rss_fetcher": {
      const cfg = config as { url?: string; maxItems?: number; mode?: string };
      if (cfg.url) {
        parts.push(`url=${cfg.url}`);
      }
      if (cfg.maxItems) {
        parts.push(`maxItems=${cfg.maxItems}`);
      }
      if (cfg.mode) {
        parts.push(`mode=${cfg.mode}`);
      }
      break;
    }
    case "litesql": {
      const cfg = config as { databaseName?: string; tableName?: string };
      if (cfg.databaseName) {
        parts.push(`database=${cfg.databaseName}`);
      }
      if (cfg.tableName) {
        parts.push(`table=${cfg.tableName}`);
      }
      break;
    }
    case "start": {
      const cfg = config as { scheduledTaskId?: string };
      if (cfg.scheduledTaskId) {
        parts.push(`scheduledTaskId=${cfg.scheduledTaskId}`);
      }
      break;
    }
    default:
      parts.push(JSON.stringify(config).substring(0, 100));
  }

  return parts.length > 0 ? parts.join(", ") : "(default)";
}

/**
 * Summarizes a JSON schema for display.
 */
function _summarizeSchema(schema: Record<string, unknown>): string {
  if (!schema || Object.keys(schema).length === 0) {
    return "(empty)";
  }

  const type: string = (schema.type as string) ?? "unknown";

  if (type === "object") {
    const properties: Record<string, unknown> =
      (schema.properties as Record<string, unknown>) ?? {};
    const propNames: string[] = Object.keys(properties);

    if (propNames.length === 0) {
      return "object {}";
    }

    const propSummaries: string[] = propNames.slice(0, 5).map((name: string) => {
      const prop: Record<string, unknown> =
        (properties[name] as Record<string, unknown>) ?? {};
      const propType: string = (prop.type as string) ?? "unknown";
      return `${name}: ${propType}`;
    });

    const more: string = propNames.length > 5
      ? `, +${propNames.length - 5} more`
      : "";

    return `object { ${propSummaries.join(", ")}${more} }`;
  }

  if (type === "array") {
    const items: Record<string, unknown> =
      (schema.items as Record<string, unknown>) ?? {};
    const itemsType: string = (items.type as string) ?? "unknown";
    return `array<${itemsType}>`;
  }

  return type;
}

//#endregion Private functions
