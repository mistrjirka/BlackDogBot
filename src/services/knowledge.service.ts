import { IKnowledgeDocument, IKnowledgeSearchResult, IKnowledgeSearchOptions } from "../shared/types/index.js";
import { DEFAULT_KNOWLEDGE_COLLECTION } from "../shared/constants.js";
import { EmbeddingService } from "./embedding.service.js";
import { VectorStoreService, IVectorRecord, IVectorSearchResult as IVectorSearchResultInternal } from "./vector-store.service.js";
import { generateId } from "../utils/id.js";

//#region KnowledgeService

export class KnowledgeService {

  //#region Data members

  private static _instance: KnowledgeService | null;

  private _embeddingService: EmbeddingService;
  private _vectorStoreService: VectorStoreService;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._embeddingService = EmbeddingService.getInstance();
    this._vectorStoreService = VectorStoreService.getInstance();
  }

  //#endregion Constructors

  //#region Public members

  public static getInstance(): KnowledgeService {
    if (!KnowledgeService._instance) {
      KnowledgeService._instance = new KnowledgeService();
    }

    return KnowledgeService._instance;
  }

  //#endregion Public members

  //#region Public methods

  public async addDocumentAsync(
    content: string,
    collection?: string,
    metadata?: Record<string, unknown>,
  ): Promise<IKnowledgeDocument> {
    const id: string = generateId();
    const vector: number[] = await this._embeddingService.embedAsync(content);
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

    await this._vectorStoreService.addAsync([record]);

    return {
      id,
      content,
      collection: record.collection,
      metadata: metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
  }

  public async searchAsync(options: IKnowledgeSearchOptions): Promise<IKnowledgeSearchResult[]> {
    const queryVector: number[] = await this._embeddingService.embedAsync(options.query);
    const results: IVectorSearchResultInternal[] = await this._vectorStoreService.searchAsync(
      queryVector,
      options.limit,
      options.collection,
    );

    const mapped: IKnowledgeSearchResult[] = results.map((result: IVectorSearchResultInternal): IKnowledgeSearchResult => {
      let parsedMetadata: Record<string, unknown>;

      try {
        parsedMetadata = JSON.parse(result.metadata) as Record<string, unknown>;
      } catch {
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

  public async editDocumentAsync(
    id: string,
    collection: string,
    content: string,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const vector: number[] = await this._embeddingService.embedAsync(content);
    const now: string = new Date().toISOString();

    const updates: Partial<Omit<IVectorRecord, "id">> = {
      content,
      collection,
      vector,
      metadata: JSON.stringify(metadata ?? {}),
      updatedAt: now,
    };

    await this._vectorStoreService.updateAsync(id, updates);
  }

  public async deleteDocumentAsync(id: string): Promise<void> {
    await this._vectorStoreService.deleteAsync(`id = '${id}'`);
  }

  public async getDocumentCountAsync(collection?: string): Promise<number> {
    return await this._vectorStoreService.countAsync(collection ?? DEFAULT_KNOWLEDGE_COLLECTION);
  }

  //#endregion Public methods
}

//#endregion KnowledgeService
