import { tool } from "ai";
import { searchKnowledgeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { KnowledgeService } from "../services/knowledge.service.js";
import { IKnowledgeSearchResult, IKnowledgeSearchOptions } from "../shared/types/index.js";

export const searchKnowledgeTool = tool({
  description: "Search the knowledge base for relevant information. Returns matching documents ranked by relevance.",
  inputSchema: searchKnowledgeToolInputSchema,
  execute: async ({ query, collection, limit }: { query: string; collection: string; limit: number }): Promise<{ results: Array<{ id: string; content: string; score: number; metadata: Record<string, unknown> }> }> => {
    const knowledgeService: KnowledgeService = KnowledgeService.getInstance();
    const options: IKnowledgeSearchOptions = { query, collection, limit, filter: null };
    const results: IKnowledgeSearchResult[] = await knowledgeService.searchAsync(options);

    return {
      results: results.map((r: IKnowledgeSearchResult) => ({
        id: r.id,
        content: r.content,
        score: r.score,
        metadata: r.metadata,
      })),
    };
  },
});
