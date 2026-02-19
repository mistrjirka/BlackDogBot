import { tool } from "ai";
import { addKnowledgeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { KnowledgeService } from "../services/knowledge.service.js";
import { IKnowledgeDocument } from "../shared/types/index.js";

export const addKnowledgeTool = tool({
  description: "Store new knowledge in the knowledge base. The content will be embedded and made searchable.",
  inputSchema: addKnowledgeToolInputSchema,
  execute: async ({ knowledge, collection, metadata }: { knowledge: string; collection: string; metadata: Record<string, unknown> }): Promise<{ id: string; success: boolean; error?: string }> => {
    try {
      const knowledgeService: KnowledgeService = KnowledgeService.getInstance();
      const doc: IKnowledgeDocument = await knowledgeService.addDocumentAsync(knowledge, collection, metadata);

      return { id: doc.id, success: true };
    } catch (error: unknown) {
      const errorMessage: string = error instanceof Error ? error.message : String(error);
      return { id: "", success: false, error: errorMessage };
    }
  },
});
