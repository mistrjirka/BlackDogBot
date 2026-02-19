import { tool } from "ai";
import { editKnowledgeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { KnowledgeService } from "../services/knowledge.service.js";

export const editKnowledgeTool = tool({
  description: "Edit an existing knowledge document by ID. Updates the content and re-embeds it.",
  inputSchema: editKnowledgeToolInputSchema,
  execute: async ({ id, collection, content, metadata }: { id: string; collection: string; content: string; metadata?: Record<string, unknown> }): Promise<{ success: boolean; message: string }> => {
    try {
      const knowledgeService: KnowledgeService = KnowledgeService.getInstance();
      await knowledgeService.editDocumentAsync(id, collection, content, metadata);

      return { success: true, message: "Knowledge document updated successfully." };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message };
    }
  },
});
