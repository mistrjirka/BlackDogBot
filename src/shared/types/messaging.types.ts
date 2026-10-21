//#region Messaging Types

export type MessagePlatform = "telegram" | "discord" | "console" | "api";

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

export interface IOutgoingPhoto {
  imageBuffer: Buffer;
  caption: string | null;
  platform: MessagePlatform;
  userId: string;
}

export interface IOutgoingFile {
  fileBuffer: Buffer;
  fileName: string;
  caption: string | null;
  platform: MessagePlatform;
  userId: string;
}

export type FileSender = (
  fileBuffer: Buffer,
  fileName: string,
  caption: string | null,
) => Promise<string | null>;

export interface IMessageHandler {
  handleMessageAsync(message: IIncomingMessage): Promise<void>;
}

//#endregion Messaging Types
