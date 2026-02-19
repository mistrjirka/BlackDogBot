import { tool } from "ai";
import { sendMessageToolInputSchema } from "../shared/schemas/tool-schemas.js";

export type MessageSender = (message: string) => Promise<string | null>;

export function createSendMessageTool(sender: MessageSender) {
  return tool({
    description:
      "Send a message to the user. Use this to communicate progress, ask clarifying questions, or deliver results.",
    inputSchema: sendMessageToolInputSchema,
    execute: async ({
      message,
    }: {
      message: string;
    }): Promise<{ sent: boolean; messageId: string | null; error?: string }> => {
      try {
        const messageId: string | null = await sender(message);
        return { sent: true, messageId };
      } catch (error: unknown) {
        const errorMessage: string = error instanceof Error ? error.message : String(error);
        return { sent: false, messageId: null, error: errorMessage };
      }
    },
  });
}
