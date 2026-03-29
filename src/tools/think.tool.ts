import { tool } from "langchain";
import { thinkToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { LoggerService } from "../services/logger.service.js";
import { ThinkOperationTracker } from "../utils/think-limit.js";

// Global tracker instance for the application
const thinkTracker = new ThinkOperationTracker({
  maxThinkOperations: 30,
  maxTotalThinkCharacters: 100000,
  maxSingleThoughtLength: 3000,
});

export const thinkTool = tool(
  async ({ thought }: { thought: string }): Promise<{ acknowledged: boolean }> => {
    const logger = LoggerService.getInstance();
    
    // Record the think operation and check limits
    const { thought: processedThought, wasTruncated } = thinkTracker.recordThinkOperation(thought);
    
    const thoughtLength = processedThought.length;
    const estimatedTokens = Math.ceil(thoughtLength / 4); // Rough estimate: ~4 chars per token
    
    logger.info("Thinking operation executed", {
      thoughtLength,
      estimatedTokens,
      wasTruncated,
      thoughtPreview: processedThought.substring(0, Math.min(200, thoughtLength)) + 
                     (thoughtLength > 200 ? "..." : ""),
    });
    
    return { acknowledged: true };
  },
  {
    name: "think",
    description: "Use this to think through a problem step by step before acting.",
    schema: thinkToolInputSchema,
  },
);

// Export the tracker for resetting between tasks
export { thinkTracker };
