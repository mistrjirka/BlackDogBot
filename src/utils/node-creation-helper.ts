import { JobStorageService } from "../services/job-storage.service.js";
import { type IJobActivityTracker } from "./job-activity-tracker.js";
import { INode, IJob, NodeType, NodeConfig } from "../shared/types/index.js";
import { checkSchemaCompatibility, ISchemaCompatResult } from "../jobs/schema-compat.js";

//#region Interfaces

export interface ICreateNodeResult {
  nodeId: string;
  success: boolean;
  message: string;
  error?: string;
}

//#endregion Interfaces

//#region Public functions

/**
 * Creates a node in storage, optionally connects a parent node to it, and tracks
 * the job as modified. Shared by all typed node-creation tools.
 */
export async function createNodeAsync(
  jobId: string,
  type: NodeType,
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  outputSchema: Record<string, unknown>,
  config: NodeConfig,
  parentNodeId: string | undefined,
  jobTracker: IJobActivityTracker,
): Promise<ICreateNodeResult> {
  const storageService: JobStorageService = JobStorageService.getInstance();

  const job: IJob | null = await storageService.getJobAsync(jobId);

  if (!job) {
    return { nodeId: "", success: false, message: `Job "${jobId}" not found.`, error: `Job "${jobId}" not found.` };
  }

  const node: INode = await storageService.addNodeAsync(
    jobId,
    type,
    name,
    description,
    inputSchema,
    outputSchema,
    config,
  );

  // Auto-connect parent → new node if parentNodeId is provided
  if (parentNodeId) {
    const parentNode: INode | null = await storageService.getNodeAsync(jobId, parentNodeId);

    if (!parentNode) {
      // Node was created; warn about missing parent but don't fail
      jobTracker.trackModified(jobId, job.name);

      return {
        nodeId: node.nodeId,
        success: true,
        message:
          `Node "${name}" created (${node.nodeId}) but parent node "${parentNodeId}" not found — connection was skipped.`,
      };
    }

    // Schema compatibility check — same guard as connect_nodes
    const compatResult: ISchemaCompatResult = checkSchemaCompatibility(parentNode.outputSchema, inputSchema);

    if (!compatResult.compatible) {
      jobTracker.trackModified(jobId, job.name);

      return {
        nodeId: node.nodeId,
        success: true,
        message:
          `Node "${name}" created (${node.nodeId}) but auto-connection from parent "${parentNodeId}" was skipped due to schema incompatibility: ${compatResult.errors.join("; ")}. ` +
          `Use connect_nodes to manually connect after fixing schemas.`,
        error: `Schema incompatibility: ${compatResult.errors.join("; ")}`,
      };
    }

    const updatedConnections: string[] = [...parentNode.connections];

    if (!updatedConnections.includes(node.nodeId)) {
      updatedConnections.push(node.nodeId);
    }

    await storageService.updateNodeAsync(jobId, parentNodeId, { connections: updatedConnections });
  }

  jobTracker.trackModified(jobId, job.name);

  const connectionNote: string = parentNodeId
    ? ` Connected from parent node "${parentNodeId}".`
    : "";

  return {
    nodeId: node.nodeId,
    success: true,
    message: `Node "${name}" (${node.nodeId}) of type "${type}" created.${connectionNote}`,
  };
}

//#endregion Public functions
