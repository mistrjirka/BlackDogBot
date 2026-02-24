import { generateText, tool } from "ai";
import { z } from "zod";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const rawModel = createOpenAICompatible({
  name: "lm-studio",
  baseURL: "http://localhost:1234/v1",
  apiKey: "lm-studio",
  fetch: async (url, init) => {
    if (init?.body && typeof init.body === "string" && init.method === "POST") {
      try {
        const body = JSON.parse(init.body);
        let modified = false;

        if (body.tools && Array.isArray(body.tools)) {
          for (const tool of body.tools) {
            if (tool.type === "function" && tool.function?.parameters) {
              if (tool.function.parameters.type !== "object") {
                tool.function.parameters.type = "object";
                modified = true;
              }
            }
          }
        }
        
        if (body.response_format && body.response_format.type === "json_object") {
          delete body.response_format;
          modified = true;
        }

        if (modified) {
          init.body = JSON.stringify(body);
        }
      } catch (e) { }
    }
    
    console.log("\n==============================");
    console.log("OUTGOING REQUEST BODY:");
    console.log(JSON.stringify(JSON.parse(init!.body as string), null, 2));
    console.log("==============================\n");
    
    const res = await fetch(url, init);
    const text = await res.text();
    
    if (!res.ok) {
      console.log("\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
      console.log(`ERROR RESPONSE (${res.status}):`);
      console.log(text);
      console.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n");
    }
    
    return new Response(text, { status: res.status, headers: res.headers });
  }
}).chatModel("mistralai/ministral-3-14b-reasoning");

async function main() {
  try {
    const result = await generateText({
      model: rawModel,
      messages: [
        { role: "user", content: "Create a database, then create a table called 'test' with one column 'id'. After that, tell me you are done." },
        { role: "assistant", content: "", toolCalls: [{ type: "tool-call", toolCallId: "call_123", toolName: "create_table", args: { tableName: "test", columns: [{ name: "id", type: "INTEGER" }]} }] },
        { role: "tool", content: [{ type: "tool-result", toolCallId: "call_123", toolName: "create_table", result: { success: true, tableName: "test" } }] }
      ],
      tools: {
        create_table: tool({
          description: "Create a table",
          parameters: z.object({
            tableName: z.string(),
            columns: z.array(z.object({ name: z.string(), type: z.string() }))
          }),
          execute: async (args: any) => { return { success: true, tableName: args.tableName }; }
        })
      }
    });
    console.log("Final message:", result.text);
  } catch (err: unknown) {
    if (err instanceof Error) {
      console.error("SDK EXCEPTION:", err.message);
    }
  }
}

main();
