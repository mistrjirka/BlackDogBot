import { tool } from "langchain";
import { searchKnowledgeToolInputSchema } from "../shared/schemas/tool-schemas.js";
import * as knowledge from "../helpers/knowledge.js";
import { IKnowledgeSearchResult, IKnowledgeSearchOptions } from "../shared/types/index.js";

export const searchKnowledgeTool = tool(
  async ({ query, collection, limit }: { query: string; collection: string; limit: number }): Promise<{ results: Array<{ id: string; content: string; score: number; metadata: Record<string, unknown> }> }> => {
    const options: IKnowledgeSearchOptions = { query, collection, limit, filter: null };
    const results: IKnowledgeSearchResult[] = await knowledge.searchKnowledgeAsync(options);

    return {
      results: results.map((r: IKnowledgeSearchResult) => ({
        id: r.id,
        content: r.content,
        score: r.score,
        metadata: r.metadata,
      })),
    };
  },
  {
    name: "search_knowledge",
    description: "Search the knowledge base for relevant information. Returns matching documents ranked by relevance.",
    schema: searchKnowledgeToolInputSchema,
  },
);
