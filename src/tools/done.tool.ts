import { tool } from "ai";
import { doneToolInputSchema } from "../shared/schemas/tool-schemas.js";

export const doneTool = tool({
  description: "Call this tool when you have completed the user's request. Provide a summary of what was accomplished.",
  inputSchema: doneToolInputSchema,
  execute: async ({ summary }: { summary: string }): Promise<{ finished: boolean }> => {
    void summary;
    return { finished: true };
  },
});
