import {
  tool,
  type LanguageModel,
  type ToolExecutionOptions,
  type ToolSet,
} from "ai";
import type { z } from "zod";
import { BaseAgentBase, type IAgentResult, type OnStepCallback } from "./base-agent.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { sanitizeSetupError } from "../helpers/skill-state.js";
import { createInspectVariableTool } from "../tools/inspect-variable.tool.js";
import { createRunCodeTool } from "../tools/run-code.tool.js";
import { createVerifyClaimEvidenceTool } from "../tools/verify-claim-evidence.tool.js";
import { MAX_DELEGATE_AGENT_OUTPUT_LENGTH } from "../shared/constants.js";
import {
  delegateAgentToolInputSchema,
  type delegateAgentToolOutputSchema,
} from "../shared/schemas/tool-schemas.js";
import type { ISubStep, SubStepBuffer } from "../shared/substep-shared.js";

const DEFAULT_DELEGATE_AGENT_MAX_STEPS: number = 20;
const DELEGATE_OUTPUT_TRUNCATION_MARKER: string = "\n[delegated output truncated]";

export type IDelegateAgentResult = z.infer<
  typeof delegateAgentToolOutputSchema
>;

export interface IDelegateAgentOptions {
  model: LanguageModel;
  tools: ToolSet;
  subSteps?: SubStepBuffer;
}

interface IDelegateWorkerOptions {
  model: LanguageModel;
  tools: ToolSet;
  abortSignal?: AbortSignal;
  /**
   * Called after each worker step with the worker's step number and tool calls.
   * The tool's execute() collects these and pushes them to the shared substep
   * buffer so the parent agent can display them as indented sub-steps.
   */
  onStepCallback?: OnStepCallback;
}

function withoutDelegateAgent(tools: ToolSet): ToolSet {
  const workerTools: ToolSet = {};
  for (const [toolName, tool] of Object.entries(tools)) {
    if (toolName !== "delegate_agent") {
      workerTools[toolName] = tool;
    }
  }
  return workerTools;
}

class DelegateWorkerAgent extends BaseAgentBase {
  private readonly _abortSignal: AbortSignal | undefined;

  public constructor(workerOptions: IDelegateWorkerOptions) {
    super({ maxSteps: DEFAULT_DELEGATE_AGENT_MAX_STEPS });
    this._abortSignal = workerOptions.abortSignal;
    // The worker owns an independent run/blackboard. Never reuse the parent's
    // inspect/run_code closure, which would silently read or mutate parent data.
    const workerTools: ToolSet = {
      ...workerOptions.tools,
      inspect_variable: createInspectVariableTool(() => this._currentVariableStore),
      run_code: createRunCodeTool(() => this._currentVariableStore),
      verify_claim_evidence: createVerifyClaimEvidenceTool(() => this._currentVariableStore),
    };
    this._buildAgent(
      workerOptions.model,
      "Complete the delegated task using only the provided tools. Do not delegate further. Report failures instead of inventing results.",
      workerTools,
      workerOptions.onStepCallback,
      undefined,
      undefined,
      undefined,
      undefined,
      (): AbortSignal | null => this._abortSignal ?? null,
    );
  }

  public async runAsync(task: string): Promise<IAgentResult> {
    return this.processMessageAsync(task, this._abortSignal);
  }
}

export function attachDelegateAgentTool(
  tools: ToolSet,
  model: LanguageModel,
  subSteps?: SubStepBuffer,
): void {
  tools.delegate_agent = createDelegateAgentTool({ model, tools, subSteps });
}

export function createDelegateAgentTool(options: IDelegateAgentOptions) {
  return tool({
    description:
      "Delegate one bounded task to a worker with the same effective tools, except delegate_agent itself.",
    inputSchema: delegateAgentToolInputSchema,
    execute: async (
      { task }: { task: string },
      executionOptions: ToolExecutionOptions<unknown>,
    ): Promise<IDelegateAgentResult> => {
      try {
        const workerTools: ToolSet = withoutDelegateAgent(options.tools);
        // Collect worker sub-steps so the parent agent can display them as
        // indented sub-steps in the Telegram progress message.
        const subSteps: ISubStep[] = [];
        const worker = new DelegateWorkerAgent({
          model: options.model,
          tools: workerTools,
          abortSignal: executionOptions.abortSignal,
          onStepCallback: async (stepNumber, toolCalls) => {
            subSteps.push({ workerStepNumber: stepNumber, toolCalls });
          },
        });
        const result = await worker.runAsync(task);
        // Push sub-steps to the shared buffer. The parent agent's
        // combinedOnStepAsync will drain them before the next main-agent step.
        options.subSteps?.push(subSteps);
        const output: string = result.text.length > MAX_DELEGATE_AGENT_OUTPUT_LENGTH
          ? `${result.text.slice(0, MAX_DELEGATE_AGENT_OUTPUT_LENGTH - DELEGATE_OUTPUT_TRUNCATION_MARKER.length)}${DELEGATE_OUTPUT_TRUNCATION_MARKER}`
          : result.text;
        return { success: true, output, error: null };
      } catch (error: unknown) {
        const message: string = sanitizeSetupError(extractErrorMessage(error));
        LoggerService.getInstance().error("Delegated worker failed", {
          error: message,
        });
        return { success: false, output: "", error: message };
      }
    },
  });
}
