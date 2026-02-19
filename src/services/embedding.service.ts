import {
  pipeline,
  FeatureExtractionPipeline,
} from "@huggingface/transformers";

import {
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDING_DIMENSION,
} from "../shared/constants.js";
import { LoggerService } from "./logger.service.js";

export class EmbeddingService {
  //#region Data members

  private static _instance: EmbeddingService | null;
  private _pipeline: FeatureExtractionPipeline | null;
  private _modelPath: string;
  private _initialized: boolean;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._pipeline = null;
    this._modelPath = "";
    this._initialized = false;
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): EmbeddingService {
    if (!EmbeddingService._instance) {
      EmbeddingService._instance = new EmbeddingService();
    }

    return EmbeddingService._instance;
  }

  public async initializeAsync(modelPath?: string): Promise<void> {
    this._modelPath = modelPath ?? DEFAULT_EMBEDDING_MODEL;

    const logger: LoggerService = LoggerService.getInstance();
    logger.info("Loading embedding model...", { modelPath: this._modelPath });

    const seenFiles: Set<string> = new Set<string>();
    let lastLoggedPercent: number = -1;

    this._pipeline = (await pipeline("feature-extraction", this._modelPath, {
      dtype: "fp32",
      progress_callback: (info: unknown): void => {
        const progress = info as {
          status: string;
          file?: string;
          progress?: number;
          loaded?: number;
          total?: number;
        };

        if (progress.status === "initiate" && progress.file) {
          if (!seenFiles.has(progress.file)) {
            seenFiles.add(progress.file);
            logger.info("Loading model file...", { file: progress.file });
          }
        } else if (progress.status === "download" && progress.file && progress.progress !== undefined) {
          const percent: number = Math.floor(progress.progress);
          const milestone: number = Math.floor(percent / 25) * 25;

          if (milestone > lastLoggedPercent && milestone > 0) {
            lastLoggedPercent = milestone;
            logger.info("Downloading model file...", {
              file: progress.file,
              percent: `${milestone}%`,
            });
          }
        } else if (progress.status === "ready") {
          logger.info("Embedding model ready.", { modelPath: this._modelPath });
        }
      },
    })) as FeatureExtractionPipeline;

    this._initialized = true;
  }

  public async embedAsync(text: string): Promise<number[]> {
    this._ensureInitialized();

    const output: unknown = await this._pipeline!(text, {
      pooling: "cls",
      normalize: true,
    });
    const result: number[][] = (output as { tolist(): number[][] }).tolist();

    return result[0];
  }

  public async embedBatchAsync(texts: string[]): Promise<number[][]> {
    this._ensureInitialized();

    if (texts.length === 0) {
      return [];
    }

    const output: unknown = await this._pipeline!(texts, {
      pooling: "cls",
      normalize: true,
    });
    const result: number[][] = (output as { tolist(): number[][] }).tolist();

    return result;
  }

  public getDimension(): number {
    return EMBEDDING_DIMENSION;
  }

  public getModelPath(): string {
    return this._modelPath;
  }

  //#endregion Public methods

  //#region Private methods

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new Error(
        "EmbeddingService not initialized. Call initializeAsync() first.",
      );
    }
  }

  //#endregion Private methods
}
