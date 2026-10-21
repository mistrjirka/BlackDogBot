import { vi } from "vitest";
import type { LanguageModel, ToolExecutionOptions } from "ai";

import type { LoggerService } from "../../src/services/logger.service.js";

/**
 * Centralized test-only casts. Keeping the unsafe assertions here makes them
 * auditable and prevents `as unknown as` from spreading through test files.
 */
export function privateOf<T>(target: unknown): T {
  return target as T;
}

export function getPrivate<T extends object, K extends keyof T>(
  target: unknown,
  key: K,
): T[K] {
  return (target as T)[key];
}

export function setPrivate<T extends object, K extends keyof T>(
  target: unknown,
  key: K,
  value: T[K],
): void {
  (target as T)[key] = value;
}

export function makeLoggerMock(): LoggerService {
  const mock = {
    events: { on: vi.fn(), emit: vi.fn() },
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logStructured: vi.fn(),
    setLogLevel: vi.fn(),
    initializeAsync: vi.fn(async (): Promise<void> => {}),
    openJobLogAsync: vi.fn(async (): Promise<void> => {}),
    closeJobLog: vi.fn(),
  };

  return privateOf<LoggerService>(mock);
}

export function makeModelMock(): LanguageModel {
  return privateOf<LanguageModel>({});
}

export function makeToolExecutionOptions(): ToolExecutionOptions<never> {
  return privateOf<ToolExecutionOptions<never>>({
    toolCallId: "test-tool-call",
    messages: [],
  });
}

export async function invokeTool<TInput, TOutput>(
  tool: { execute?: (...args: never[]) => unknown },
  input: TInput,
  options: ToolExecutionOptions<never> = makeToolExecutionOptions(),
): Promise<TOutput> {
  if (!tool.execute) {
    throw new Error("Tool has no execute function");
  }

  return await (tool.execute as (input: TInput, options: ToolExecutionOptions<never>) => Promise<TOutput>)(
    input,
    options,
  );
}
