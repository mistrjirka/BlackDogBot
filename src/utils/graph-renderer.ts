import { execFile } from "node:child_process";

import { INode } from "../shared/types/index.js";
import { LoggerService } from "../services/logger.service.js";

//#region Constants

const RENDER_TIMEOUT_MS: number = 20000;

interface INodeStyle {
  fillcolor: string;
  color: string;
  fontcolor: string;
}

const NODE_TYPE_STYLES: Record<string, INodeStyle> = {
  start: { fillcolor: "#e8eaf6", color: "#3949ab", fontcolor: "#1a237e" },
  manual: { fillcolor: "#e8f5e9", color: "#43a047", fontcolor: "#1b5e20" },
  curl_fetcher: { fillcolor: "#e3f2fd", color: "#1e88e5", fontcolor: "#0d47a1" },
  rss_fetcher: { fillcolor: "#e3f2fd", color: "#1e88e5", fontcolor: "#0d47a1" },
  crawl4ai: { fillcolor: "#e3f2fd", color: "#1e88e5", fontcolor: "#0d47a1" },
  searxng: { fillcolor: "#e3f2fd", color: "#1e88e5", fontcolor: "#0d47a1" },
  python_code: { fillcolor: "#fff3e0", color: "#fb8c00", fontcolor: "#e65100" },
  output_to_ai: { fillcolor: "#f3e5f5", color: "#8e24aa", fontcolor: "#4a148c" },
  agent: { fillcolor: "#fce4ec", color: "#e53935", fontcolor: "#b71c1c" },
  litesql: { fillcolor: "#ffebee", color: "#c62828", fontcolor: "#b71c1c" },
};

const DEFAULT_NODE_STYLE: INodeStyle = {
  fillcolor: "#f5f5f5",
  color: "#9e9e9e",
  fontcolor: "#212121",
};

//#endregion Constants

//#region Public functions

export function buildDotDiagram(
  nodes: INode[],
  entrypointNodeId: string | null,
  _jobName: string,
): string {
  const lines: string[] = [];

  lines.push("digraph G {");
  lines.push('  rankdir=TD;');
  lines.push('  node [shape=box, style="filled,rounded", fontname="Arial"];');
  lines.push("");

  // Node definitions
  for (const node of nodes) {
    const sanitizedName: string = sanitizeDotLabel(node.name);
    const typeLabel: string = node.type.replace(/_/g, " ");
    const isEntrypoint: boolean = node.nodeId === entrypointNodeId;
    const entrypointMarker: string = isEntrypoint ? " ⬥" : "";
    const label: string = `${sanitizedName}${entrypointMarker}\\n${typeLabel}`;
    const nodeRef: string = sanitizeNodeId(node.nodeId);
    const style: INodeStyle = NODE_TYPE_STYLES[node.type] ?? DEFAULT_NODE_STYLE;

    lines.push(
      `  ${nodeRef} [label="${label}", fillcolor="${style.fillcolor}", color="${style.color}", fontcolor="${style.fontcolor}"];`,
    );
  }

  lines.push("");

  // Edges
  for (const node of nodes) {
    const fromRef: string = sanitizeNodeId(node.nodeId);

    for (const targetId of node.connections) {
      const toRef: string = sanitizeNodeId(targetId);

      lines.push(`  ${fromRef} -> ${toRef};`);
    }
  }

  lines.push("}");

  return lines.join("\n");
}

export async function renderGraphToImageAsync(dotCode: string): Promise<Buffer> {
  const logger: LoggerService = LoggerService.getInstance();

  logger.debug("Rendering DOT diagram via local graphviz", { codeLength: dotCode.length });

  return new Promise<Buffer>((resolve: (value: Buffer) => void, reject: (reason: Error) => void): void => {
    const child = execFile(
      "dot",
      ["-Tpng"],
      { timeout: RENDER_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, encoding: "buffer" },
      (error: Error | null, stdout: Buffer): void => {
        if (error) {
          const message: string = error.message;

          if (message.includes("TIMEOUT") || message.includes("timed out") || ("killed" in error && error.killed)) {
            reject(new Error(`Graph rendering timed out after ${RENDER_TIMEOUT_MS}ms`));
            return;
          }

          reject(new Error(`Graph rendering failed: ${message}`));
          return;
        }

        logger.debug("DOT diagram rendered", { imageSize: stdout.length });
        resolve(stdout);
      },
    );

    child.stdin!.write(dotCode);
    child.stdin!.end();
  });
}

//#endregion Public functions

//#region Private functions

function sanitizeDotLabel(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ");
}

function sanitizeNodeId(nodeId: string): string {
  return `n_${nodeId.replace(/[^a-zA-Z0-9]/g, "_")}`;
}

//#endregion Private functions
