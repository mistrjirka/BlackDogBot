import { tool } from "ai";
import { thinkToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";

export const thinkTool = tool({
  description: "Use this to think through a problem step by step before acting.",
  inputSchema: thinkToolInputSchema,
  execute: async ({ thought }: { thought: string }): Promise<{ acknowledged: boolean }> => {
    const logger = LoggerService.getInstance();

    const thoughtLength = thought.length;
    const estimatedTokens = Math.ceil(thoughtLength / 4); // Rough estimate: ~4 chars per token

    logger.info("Thinking operation executed", {
      thoughtLength,
      estimatedTokens,
      thoughtPreview: thought.substring(0, Math.min(200, thoughtLength)) +
                     (thoughtLength > 200 ? "..." : ""),
    });

    return { acknowledged: true };
  },
});
