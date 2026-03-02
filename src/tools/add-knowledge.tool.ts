import { tool } from "ai";
import { addKnowledgeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import * as knowledge from "../helpers/knowledge.js";
import { extractErrorMessage } from "../utils/error.js";
import { IKnowledgeDocument } from "../shared/types/index.js";

export const addKnowledgeTool = tool({
  description: "Store new knowledge in the knowledge base. The content will be embedded and made searchable.",
  inputSchema: addKnowledgeToolInputSchema,
  execute: async ({ knowledge: knowledgeContent, collection, metadata }: { knowledge: string; collection: string; metadata: Record<string, unknown> }): Promise<{ id: string; success: boolean; error?: string }> => {
    try {
      const doc: IKnowledgeDocument = await knowledge.addKnowledgeDocumentAsync(knowledgeContent, collection, metadata);

      return { id: doc.id, success: true };
    } catch (error: unknown) {
      const errorMessage: string = extractErrorMessage(error);
      return { id: "", success: false, error: errorMessage };
    }
  },
});
