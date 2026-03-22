import type { ILlmResponse } from "../shared/types/index.js";

export type ProbeToolChoice = "required" | "auto";

export interface IToolCallingProbeArgs {
  url: string;
  model: string;
  prompt: string;
  toolChoice: ProbeToolChoice;
  maxTokens: number;
  timeoutMs?: number;
  apiKey?: string;
  providerPayload?: Record<string, unknown>;
}

export interface IToolCallingProbeResult {
  ok: boolean;
  status: number;
  hasToolCalls: boolean;
}

export function createEmitProbeToolDefinition(): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: "emit_probe",
      description: "Probe tool support",
      parameters: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
  };
}

export async function runToolCallingProbeAsync(
  args: IToolCallingProbeArgs,
): Promise<IToolCallingProbeResult> {
  const timeoutMs: number = typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs) && args.timeoutMs > 0
    ? args.timeoutMs
    : 30_000;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (args.apiKey && args.apiKey.length > 0) {
    headers.Authorization = `Bearer ${args.apiKey}`;
  }

  const body: Record<string, unknown> = {
    model: args.model,
    messages: [{ role: "user", content: args.prompt }],
    tools: [createEmitProbeToolDefinition()],
    tool_choice: args.toolChoice,
    max_tokens: args.maxTokens,
    ...(args.providerPayload ? { provider: args.providerPayload } : {}),
  };

  const controller: AbortController = new AbortController();
  const timeoutId: NodeJS.Timeout = setTimeout((): void => {
    controller.abort();
  }, timeoutMs);

  let response: Response;

  try {
    response = await fetch(args.url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify(body),
    });
  } catch {
    return {
      ok: false,
      status: 0,
      hasToolCalls: false,
    };
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      hasToolCalls: false,
    };
  }

  const json = await response.json() as ILlmResponse;
  const toolCalls = json.choices?.[0]?.message?.tool_calls;

  return {
    ok: true,
    status: response.status,
    hasToolCalls: Array.isArray(toolCalls) && toolCalls.length > 0,
  };
}
