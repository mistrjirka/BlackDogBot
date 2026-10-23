import { Agent, type Dispatcher } from "undici";

// Native fetch can supply its own 300-second parser timeout per dispatch.
// Override it here, only for model traffic. The request AbortSignal owns the
// deadline, including reading the body. Do not change the global dispatcher.
class LlmDispatcher extends Agent {
  override dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    return super.dispatch({ ...options, headersTimeout: 0, bodyTimeout: 0 }, handler);
  }
}

const dispatcher = new LlmDispatcher();

export function fetchLlmAsync(url: string | URL | Request, init?: RequestInit): Promise<Response> {
  // Node and the installed Undici package carry separate structural types.
  const options: RequestInit = { ...init, dispatcher: dispatcher as unknown as RequestInit["dispatcher"] };
  return fetch(url, options);
}

export class LlmIncompleteResponseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "LlmIncompleteResponseError";
  }
}

export class LlmRequestTimeoutError extends Error {
  constructor(timeoutMs: number, attempt: number, total: number, cause: unknown) {
    super(`Model response timed out after ${timeoutMs / 1000}s (attempt ${attempt}/${total})`, { cause });
    this.name = "LlmRequestTimeoutError";
  }
}
