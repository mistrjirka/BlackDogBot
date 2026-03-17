import { AsyncLocalStorage } from "node:async_hooks";

//#region Types

export type LlmCallContextType =
  | "agent_primary"
  | "summarization"
  | "schema_extraction"
  | "cron_history"
  | "job_execution";

interface ILlmCallContextStore {
  callType: LlmCallContextType;
}

//#endregion Types

//#region Data members

const _LlmCallContextStorage: AsyncLocalStorage<ILlmCallContextStore> = new AsyncLocalStorage<ILlmCallContextStore>();

//#endregion Data members

//#region Public functions

export async function runWithLlmCallTypeAsync<T>(
  callType: LlmCallContextType,
  operation: () => Promise<T>,
): Promise<T> {
  return await _LlmCallContextStorage.run({ callType }, operation);
}

export function getCurrentLlmCallType(): LlmCallContextType | null {
  const store: ILlmCallContextStore | undefined = _LlmCallContextStorage.getStore();
  return store?.callType ?? null;
}

//#endregion Public functions
