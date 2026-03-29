import { tool } from "langchain";
import { editKnowledgeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import * as knowledge from "../helpers/knowledge.js";

export const editKnowledgeTool = tool(
  async ({ id, collection, content, metadata }: { id: string; collection: string; content: string; metadata?: Record<string, unknown> }): Promise<{ success: boolean; message: string }> => {
    try {
      await knowledge.editKnowledgeDocumentAsync(id, collection, content, metadata);

      return { success: true, message: "Knowledge document updated successfully." };
    } catch (error: unknown) {
      return { success: false, message: (error as Error).message };
    }
  },
  {
    name: "edit_knowledge",
    description: "Edit an existing knowledge document by ID. Updates the content and re-embeds it.",
    schema: editKnowledgeToolInputSchema,
  },
);
