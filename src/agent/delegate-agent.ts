import {
  tool,
  type LanguageModel,
  type ToolExecutionOptions,
  type ToolSet,
} from "ai";
import type { z } from "zod";
import { BaseAgentBase, type IAgentResult } from "./base-agent.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { sanitizeSetupError } from "../helpers/skill-state.js";
import { MAX_DELEGATE_AGENT_OUTPUT_LENGTH } from "../shared/constants.js";
import {
  delegateAgentToolInputSchema,
  type delegateAgentToolOutputSchema,
} from "../shared/schemas/tool-schemas.js";

const DEFAULT_DELEGATE_AGENT_MAX_STEPS: number = 20;
const DELEGATE_OUTPUT_TRUNCATION_MARKER: string = "\n[delegated output truncated]";

export type IDelegateAgentResult = z.infer<
  typeof delegateAgentToolOutputSchema
>;

export interface IDelegateAgentOptions {
  model: LanguageModel;
  tools: ToolSet;
}

interface IDelegateWorkerOptions {
  model: LanguageModel;
  tools: ToolSet;
  abortSignal?: AbortSignal;
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
    this._buildAgent(
      workerOptions.model,
      "Complete the delegated task using only the provided tools. Do not delegate further. Report failures instead of inventing results.",
      workerOptions.tools,
      undefined,
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
): void {
  tools.delegate_agent = createDelegateAgentTool({ model, tools });
}

export function createDelegateAgentTool(options: IDelegateAgentOptions) {
  return tool({
    description:
      "Delegate one bounded task to a worker with the same effective tools, except delegate_agent itself.",
    inputSchema: delegateAgentToolInputSchema,
    execute: async (
      { task }: { task: string },
      executionOptions: ToolExecutionOptions,
    ): Promise<IDelegateAgentResult> => {
      try {
        const workerTools: ToolSet = withoutDelegateAgent(options.tools);
        const worker = new DelegateWorkerAgent({
          model: options.model,
          tools: workerTools,
          abortSignal: executionOptions.abortSignal,
        });
        const result = await worker.runAsync(task);
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
