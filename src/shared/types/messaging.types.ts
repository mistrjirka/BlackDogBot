//#region Messaging Types

export type MessagePlatform = "telegram" | "console" | "api";

export interface IIncomingMessage {
  id: string;
  platform: MessagePlatform;
  text: string;
  userId: string;
  userName: string | null;
  timestamp: number;
  raw: unknown;
}

export interface IOutgoingMessage {
  text: string;
  platform: MessagePlatform;
  userId: string;
  replyToMessageId: string | null;
}

export interface IMessageHandler {
  handleMessageAsync(message: IIncomingMessage): Promise<void>;
}

//#endregion Messaging Types
