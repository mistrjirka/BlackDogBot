import { HumanMessage, AIMessage, SystemMessage, ToolMessage, BaseMessage } from "@langchain/core/messages";

interface IVercelPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
}

export interface IModelMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string | IVercelPart[];
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }>;
  toolCallId?: string;
}

function extractTextFromParts(parts: IVercelPart[]): string {
  return parts.map((part) => part.text ?? "").join("");
}

function convertImageDataToBase64(imageData: unknown): string {
  if (imageData instanceof Uint8Array) {
    const base64 = Buffer.from(imageData).toString("base64");
    return `data:image/png;base64,${base64}`;
  }
  if (Buffer.isBuffer(imageData)) {
    return `data:image/png;base64,${imageData.toString("base64")}`;
  }
  if (typeof imageData === "string") {
    return imageData;
  }
  throw new Error("Unsupported image data format");
}

function vercelPartsToMultimodalContent(parts: IVercelPart[]): Array<{ type: string; text?: string; image?: string }> {
  return parts.map((part) => {
    if (part.type === "image_url" || part.type === "image") {
      const imageUrl = part.image_url?.url ?? part.text;
      if (typeof imageUrl !== "string") {
        return { type: "image", image: imageUrl };
      }
      if (imageUrl.startsWith("data:")) {
        return { type: "image", image: imageUrl };
      }
      if (imageUrl.startsWith("http") || imageUrl.startsWith("/")) {
        return { type: "image", image: imageUrl };
      }
      return { type: "image", image: convertImageDataToBase64(imageUrl) };
    }
    return { type: "text", text: part.text ?? "" };
  });
}

export function modelMessagesToLangChain(messages: IModelMessage[]): BaseMessage[] {
  return messages.map((msg): BaseMessage => {
    if (msg.role === "system") {
      const content = typeof msg.content === "string" ? msg.content : extractTextFromParts(msg.content as IVercelPart[]);
      return new SystemMessage({ content });
    }

    if (msg.role === "tool") {
      const content = typeof msg.content === "string" ? msg.content : extractTextFromParts(msg.content as IVercelPart[]);
      return new ToolMessage({ content, tool_call_id: msg.toolCallId ?? "" });
    }

    if (msg.role === "assistant") {
      const content = typeof msg.content === "string" ? msg.content : extractTextFromParts(msg.content as IVercelPart[]);

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        const toolCalls = msg.toolCalls.map((tc) => ({
          name: tc.toolName,
          args: tc.args as Record<string, unknown>,
          id: tc.toolCallId,
        }));
        return new AIMessage({ content, tool_calls: toolCalls });
      }
      return new AIMessage({ content });
    }

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        return new HumanMessage({ content: msg.content });
      }
      const parts = msg.content as IVercelPart[];
      const hasImages = parts.some((p) => p.type === "image_url" || p.type === "image");
      if (hasImages) {
        return new HumanMessage({ content: vercelPartsToMultimodalContent(parts) });
      }
      return new HumanMessage({ content: extractTextFromParts(parts) });
    }

    return new HumanMessage({ content: typeof msg.content === "string" ? msg.content : extractTextFromParts(msg.content as IVercelPart[]) });
  });
}

function langChainContentToVercel(message: HumanMessage | AIMessage | SystemMessage | ToolMessage): string | IVercelPart[] {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  return content.map((part): IVercelPart => {
    if (part.type === "image") {
      return { type: "image", text: part.image as string };
    }
    return { type: "text", text: (part.text as string) ?? "" };
  });
}

export function langChainMessagesToModel(messages: BaseMessage[]): IModelMessage[] {
  return messages.map((msg): IModelMessage => {
    if (msg instanceof SystemMessage) {
      return { role: "system", content: msg.content as string };
    }

    if (msg instanceof ToolMessage) {
      return { role: "tool", content: msg.content as string, toolCallId: msg.tool_call_id };
    }

    if (msg instanceof AIMessage) {
      const content = langChainContentToVercel(msg);
      const toolCalls = msg.tool_calls?.map((tc) => ({
        toolCallId: tc.id ?? "",
        toolName: tc.name,
        args: tc.args,
      }));
      return { role: "assistant", content, toolCalls };
    }

    if (msg instanceof HumanMessage) {
      return { role: "user", content: langChainContentToVercel(msg) };
    }

    return { role: "user", content: msg.content as string };
  });
}
