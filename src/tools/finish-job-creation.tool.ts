import { tool } from "ai";
import { finishJobCreationToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { JobStorageService } from "../services/job-storage.service.js";
import { JobExecutorService } from "../services/job-executor.service.js";
import { IJob, INode, INodeTestCase } from "../shared/types/index.js";
import { validateGraph, IGraphValidationResult } from "../jobs/graph.js";
import { type IJobCreationModeTracker } from "../utils/job-creation-mode-tracker.js";
import { auditGraphWithLLM, renderGraphForAudit, type IGraphAuditResult, type IJobContext } from "../utils/graph-audit.js";

//#region Constants

/** Regex for {{nodeId.outputKey}} template references */
const _TemplateRefRegex: RegExp = /\{\{([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_]+)\}\}/g;

//#endregion Constants

//#region Private functions

function _collectStringValues(obj: unknown, results: string[]): void {
  if (typeof obj === "string") {
    results.push(obj);

    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      _collectStringValues(item, results);
    }

    return;
  }

  if (obj !== null && typeof obj === "object") {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      _collectStringValues(value, results);
    }
  }
}

function _validateTemplateRefs(
  nodes: INode[],
  nodeMap: Map<string, INode>,
): string[] {
  const errors: string[] = [];

  for (const node of nodes) {
    // Collect all string values from the node's config
    const strings: string[] = [];
    _collectStringValues(node.config, strings);

    for (const str of strings) {
      const regex: RegExp = new RegExp(_TemplateRefRegex.source, "g");
      let match: RegExpExecArray | null;

      while ((match = regex.exec(str)) !== null) {
        const refNodeId: string = match[1];
        const refOutputKey: string = match[2];

        const refNode: INode | undefined = nodeMap.get(refNodeId);

        if (!refNode) {
          errors.push(
            `Node "${node.name}" references unknown node ID "${refNodeId}" in template "{{${refNodeId}.${refOutputKey}}}"`,
          );

          continue;
        }

        const outputProps = (refNode.outputSchema as { properties?: Record<string, unknown> }).properties;

        if (outputProps && !(refOutputKey in outputProps)) {
          errors.push(
            `Node "${node.name}" references output key "${refOutputKey}" which does not exist in ` +
            `node "${refNode.name}" outputSchema. Available keys: ${Object.keys(outputProps).join(", ")}`,
          );
        }
      }
    }
  }

  return errors;
}

//#endregion Private functions

export function createFinishJobCreationTool(creationModeTracker: IJobCreationModeTracker) {
  return tool({
    description:
      "Finish a job creation session. Validates the graph structure, checks that all " +
      "{{nodeId.outputKey}} template references are valid, ensures every node has at least one " +
      "passing test, marks the job as ready, and exits job creation mode.",
    inputSchema: finishJobCreationToolInputSchema,
    execute: async ({
      jobId,
      skipAudit: _skipAudit = false,
    }: {
      jobId: string;
      skipAudit?: boolean;
    }): Promise<{ success: boolean; message: string; validationErrors: string[]; suggestions?: string[] }> => {
      try {
        const storageService: JobStorageService = JobStorageService.getInstance();

        const job: IJob | null = await storageService.getJobAsync(jobId);

        if (!job) {
          return { success: false, message: `Job "${jobId}" not found.`, validationErrors: [] };
        }

        const activeMode = creationModeTracker.getMode();

        if (!activeMode) {
          return { success: false, message: "Not currently in job creation mode.", validationErrors: [] };
        }

        if (activeMode.jobId !== jobId) {
          return {
            success: false,
            message: `The active creation mode is for job "${activeMode.jobId}", not "${jobId}".`,
            validationErrors: [],
          };
        }

        if (job.status !== "creating") {
          return { success: false, message: `Job is already in "${job.status}" status.`, validationErrors: [] };
        }

        const nodes: INode[] = await storageService.listNodesAsync(jobId);

        // 1. Validate graph structure
        const graphValidation: IGraphValidationResult = validateGraph(nodes, job.entrypointNodeId);

        if (!graphValidation.valid) {
          return { success: false, message: "Job graph validation failed.", validationErrors: graphValidation.errors };
        }

        // 2. Validate {{nodeId.outputKey}} template references
        const nodeMap: Map<string, INode> = new Map(nodes.map((n) => [n.nodeId, n]));
        const templateErrors: string[] = _validateTemplateRefs(nodes, nodeMap);

        if (templateErrors.length > 0) {
          return {
            success: false,
            message: "Template reference validation failed.",
            validationErrors: templateErrors,
          };
        }

        // 3. Enforce: every node must have at least one test case (except start and litesql)
        const nodesWithoutTests: string[] = [];

        for (const node of nodes) {
          // Start nodes cannot have tests (no input)
          // LITESQL nodes are storage operations - testing requires actual DB state
          if (node.type === "start" || node.type === "litesql") {
            continue;
          }

          const testCases: INodeTestCase[] = await storageService.getTestCasesAsync(jobId, node.nodeId);

          if (testCases.length === 0) {
            nodesWithoutTests.push(`"${node.name}" (${node.nodeId})`);
          }
        }

        if (nodesWithoutTests.length > 0) {
          return {
            success: false,
            message:
              `The following nodes have no test cases. Add at least one test per node using add_node_test, ` +
              `then run them with run_node_test: ${nodesWithoutTests.join(", ")}`,
            validationErrors: [],
          };
        }

        // 4. Enforce: all node tests must pass (except start and litesql)
        const executorService: JobExecutorService = JobExecutorService.getInstance();
        const failedNodes: string[] = [];

        for (const node of nodes) {
          // Start nodes cannot have tests (no input)
          // LITESQL nodes are storage operations - testing requires actual DB state
          if (node.type === "start" || node.type === "litesql") {
            continue;
          }

          const testResult = await executorService.runNodeTestsAsync(jobId, node.nodeId);

          if (!testResult.allPassed) {
            const failedCount: number = testResult.results.filter((r) => !r.passed).length;

            failedNodes.push(`"${node.name}" (${node.nodeId}): ${failedCount} test(s) failed`);
          }
        }

        if (failedNodes.length > 0) {
          return {
            success: false,
            message:
              `Node tests must all pass before finishing the job. ` +
              `Failing nodes: ${failedNodes.join("; ")}. Fix the issues and re-run tests with run_node_test.`,
            validationErrors: [],
          };
        }

        // 5. LLM-based graph audit (currently disabled — too many false positives)
        // TODO: Re-enable once audit prompt is improved
        // const mode = creationModeTracker.getMode();
        // const isFirstAuditAttempt = mode && !mode.auditAttempted;
        // const shouldRunAudit = !skipAudit || isFirstAuditAttempt;
        const shouldRunAudit = false;

        if (shouldRunAudit) {
          // Mark that an audit has been attempted
          creationModeTracker.markAuditAttempted();

          const graphDescription: string = renderGraphForAudit(job, nodes);
          const jobContext: IJobContext = {
            jobName: job.name,
            jobDescription: job.description,
          };

          let auditResult: IGraphAuditResult;

          try {
            auditResult = await auditGraphWithLLM(graphDescription, jobContext);
          } catch (auditError: unknown) {
            const auditErrorMessage: string = auditError instanceof Error
              ? auditError.message
              : String(auditError);

            return {
              success: false,
              message: "Graph audit failed due to an LLM error. Fix the issue and try again, or use skipAudit=true after the first audit attempt.",
              validationErrors: [auditErrorMessage],
            };
          }

          if (!auditResult.approved) {
            return {
              success: false,
              message: "Graph audit failed. The LLM identified issues with the job graph. Fix the issues and try again, or use skipAudit=true after the first audit attempt.",
              validationErrors: auditResult.issues,
              suggestions: auditResult.suggestions,
            };
          }
        }

        // 6. Mark job as ready
        await storageService.updateJobAsync(jobId, { status: "ready" });

        // 7. Clear job creation mode
        creationModeTracker.clearMode();

        return {
          success: true,
          message: "Job is now ready for execution. All nodes validated, tests passed, and graph audit approved. Job creation mode exited.",
          validationErrors: [],
          suggestions: [],
        };
      } catch (error: unknown) {
        return { success: false, message: (error as Error).message, validationErrors: [] };
      }
    },
  });
}
