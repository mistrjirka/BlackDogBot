import { tool } from "ai";
import { thinkToolInputSchema } from "../shared/schemas/tool-schemas.js";

export const thinkTool = tool({
  description: "Use this to think through a problem step by step before acting.",
  inputSchema: thinkToolInputSchema,
  execute: async ({ thought }: { thought: string }): Promise<{ acknowledged: boolean }> => {
    void thought;
    return { acknowledged: true };
  },
});
