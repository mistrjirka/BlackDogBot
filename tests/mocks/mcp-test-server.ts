import process from "node:process";

//#region Types

interface IJsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface IJsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

//#endregion Types

//#region Tool Definitions

const TOOLS = [
  {
    name: "echo",
    description: "Echoes the input message back",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Message to echo",
        },
      },
      required: ["message"],
    },
    outputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "echo_image",
    description: "Echoes a message with an image",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
        },
      },
      required: ["message"],
    },
    outputSchema: {
      type: "object",
      properties: {
        hasImage: {
          type: "boolean",
        },
      },
      required: ["hasImage"],
    },
  },
  {
    name: "no_schema_tool",
    description: "A tool without output schema",
    inputSchema: {
      type: "object",
      properties: {
        x: {
          type: "number",
        },
      },
      required: ["x"],
    },
  },
];

const PROTOCOL_VERSION = "2025-06-18";

//#endregion Tool Definitions

//#region Handlers

function handleInitialize(params: Record<string, unknown>): unknown {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
    serverInfo: {
      name: "test-mcp-server",
      version: "1.0.0",
    },
  };
}

function handleToolsList(): unknown {
  return {
    tools: TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
    })),
  };
}

function handleToolsCall(params: Record<string, unknown>): unknown {
  const { name, arguments: args } = params as {
    name: string;
    arguments: Record<string, unknown>;
  };

  switch (name) {
    case "echo": {
      const input = args as { message: string };
      return {
        content: [{ type: "text", text: input.message }],
        structuredContent: { text: input.message },
      };
    }

    case "echo_image": {
      const input = args as { message: string };
      return {
        content: [
          { type: "text", text: "Image for: " + input.message },
          {
            type: "image",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            mimeType: "image/png",
          },
        ],
        structuredContent: { hasImage: true },
      };
    }

    case "no_schema_tool": {
      const input = args as { x: number };
      return {
        content: [{ type: "text", text: String(input.x * 2) }],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

//#endregion Handlers

//#region Message Processing

function sendResponse(response: IJsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

function processRequest(request: IJsonRpcRequest): void {
  try {
    let result: unknown;

    switch (request.method) {
      case "initialize":
        result = handleInitialize(request.params ?? {});
        break;

      case "tools/list":
        result = handleToolsList();
        break;

      case "tools/call":
        result = handleToolsCall(request.params ?? {});
        break;

      case "notifications/initialized":
        result = null;
        break;

      default:
        sendResponse({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32601,
            message: `Method not found: ${request.method}`,
          },
        });
        return;
    }

    sendResponse({
      jsonrpc: "2.0",
      id: request.id,
      result,
    });
  } catch (error) {
    sendResponse({
      jsonrpc: "2.0",
      id: request.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : "Internal error",
      },
    });
  }
}

//#endregion Message Processing

//#region Main Loop

let buffer = "";

process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk: string) => {
  buffer += chunk;

  let newlineIndex: number;
  while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);

    if (!line) {
      continue;
    }

    try {
      const request = JSON.parse(line) as IJsonRpcRequest;
      processRequest(request);
    } catch {
      sendResponse({
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: "Parse error",
        },
      });
    }
  }
});

process.stdin.on("end", () => {
  process.exit(0);
});

//#endregion Main Loop
