//#region Classes

export class ChatNotFoundError extends Error {
  public readonly chatId: string;

  constructor(chatId: string) {
    super(`Chat not found: ${chatId}`);
    this.name = "ChatNotFoundError";
    this.chatId = chatId;
  }
}

//#endregion Classes

//#region Public Functions

export function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

//#endregion Public Functions

/** Bounded cause chain only. Never serialize request objects or credentials. */
export function extractErrorCauses(error: unknown): { name: string; message: string; code?: string }[] {
  const causes: { name: string; message: string; code?: string }[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current instanceof Error && causes.length < 8 && !seen.has(current)) {
    seen.add(current);
    const code = (current as Error & { code?: unknown }).code;
    causes.push({ name: current.name, message: current.message, ...(typeof code === "string" ? { code } : {}) });
    current = current.cause;
  }
  return causes;
}
