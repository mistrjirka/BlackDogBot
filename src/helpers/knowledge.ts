import { IKnowledgeDocument, IKnowledgeSearchResult, IKnowledgeSearchOptions } from "../shared/types/index.js";
import { DEFAULT_KNOWLEDGE_COLLECTION } from "../shared/constants.js";
import { EmbeddingService } from "../services/embedding.service.js";
import { VectorStoreService, IVectorRecord, IVectorSearchResult as IVectorSearchResultInternal } from "../services/vector-store.service.js";
import { LoggerService } from "../services/logger.service.js";
import { extractErrorMessage } from "../utils/error.js";
import { generateId } from "../utils/id.js";

//#region Public Functions

export async function addKnowledgeDocumentAsync(
  content: string,
  collection?: string,
  metadata?: Record<string, unknown>,
): Promise<IKnowledgeDocument> {
  const embeddingService: EmbeddingService = EmbeddingService.getInstance();
  const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();
  
  const id: string = generateId();
  const vector: number[] = await embeddingService.embedAsync(content);
  const now: string = new Date().toISOString();

  const record: IVectorRecord = {
    id,
    content,
    collection: collection ?? DEFAULT_KNOWLEDGE_COLLECTION,
    vector,
    metadata: JSON.stringify(metadata ?? {}),
    createdAt: now,
    updatedAt: now,
  };

  await vectorStoreService.addAsync([record]);

  return {
    id,
    content,
    collection: record.collection,
    metadata: metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };
}

export async function searchKnowledgeAsync(options: IKnowledgeSearchOptions): Promise<IKnowledgeSearchResult[]> {
  const embeddingService: EmbeddingService = EmbeddingService.getInstance();
  const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();
  
  const queryVector: number[] = await embeddingService.embedAsync(options.query);
  const results: IVectorSearchResultInternal[] = await vectorStoreService.searchAsync(
    queryVector,
    options.limit,
    options.collection,
  );

  const mapped: IKnowledgeSearchResult[] = results.map((result: IVectorSearchResultInternal): IKnowledgeSearchResult => {
    let parsedMetadata: Record<string, unknown>;

    try {
      parsedMetadata = JSON.parse(result.metadata) as Record<string, unknown>;
    } catch (error: unknown) {
      const logger = LoggerService.getInstance();
      logger.warn("Failed to parse knowledge document metadata, using empty object", {
        documentId: result.id,
        error: extractErrorMessage(error),
      });
      parsedMetadata = {};
    }

    return {
      id: result.id,
      content: result.content,
      collection: result.collection,
      metadata: parsedMetadata,
      score: result.score,
    };
  });

  return mapped;
}

export async function editKnowledgeDocumentAsync(
  id: string,
  collection: string,
  content: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const embeddingService: EmbeddingService = EmbeddingService.getInstance();
  const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();
  
  const vector: number[] = await embeddingService.embedAsync(content);
  const now: string = new Date().toISOString();

  const updates: Partial<Omit<IVectorRecord, "id">> = {
    content,
    collection,
    vector,
    metadata: JSON.stringify(metadata ?? {}),
    updatedAt: now,
  };

  await vectorStoreService.updateAsync(id, updates);
}

export async function deleteKnowledgeDocumentAsync(id: string): Promise<void> {
  const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();
  
  await vectorStoreService.deleteAsync(`id = '${id}'`);
}

export async function getKnowledgeDocumentCountAsync(collection?: string): Promise<number> {
  const vectorStoreService: VectorStoreService = VectorStoreService.getInstance();
  
  return await vectorStoreService.countAsync(collection ?? DEFAULT_KNOWLEDGE_COLLECTION);
}

//#endregion Public Functions
