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
