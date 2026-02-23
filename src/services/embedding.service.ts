import { exec } from "child_process";
import { promisify } from "util";
import { rm } from "fs/promises";
import path from "path";

import {
  env,
  pipeline,
  FeatureExtractionPipeline,
} from "@huggingface/transformers";

// transformers.js ONNX backend only exposes "cpu" and "cuda" as device options.
type PipelineDevice = "cpu" | "cuda";

const _execAsync = promisify(exec);

import {
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_EMBEDDING_DTYPE,
  DEFAULT_EMBEDDING_DEVICE,
  EMBEDDING_DIMENSION,
} from "../shared/constants.js";
import type { EmbeddingDevice, EmbeddingDtype } from "../shared/types/index.js";
import { LoggerService } from "./logger.service.js";
import { StatusService } from "./status.service.js";
import { getModelsDir } from "../utils/paths.js";

//#region Corruption error patterns

const CorruptionPatterns: RegExp[] = [
  /Deserialize tensor/i,
  /out of bounds/i,
  /can not be read in full/i,
  /GetExtDataFromTensorProto/i,
];

//#endregion Corruption error patterns

export class EmbeddingService {
  //#region Data members

  private static _instance: EmbeddingService | null;
  private _pipeline: FeatureExtractionPipeline | null;
  private _modelPath: string;
  private _dtype: EmbeddingDtype;
  private _device: PipelineDevice;
  private _initialized: boolean;
  private _initializationPromise: Promise<void> | null;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._pipeline = null;
    this._modelPath = "";
    this._dtype = "q8";
    this._device = "cpu";
    this._initialized = false;
    this._initializationPromise = null;
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): EmbeddingService {
    if (!EmbeddingService._instance) {
      EmbeddingService._instance = new EmbeddingService();
    }

    return EmbeddingService._instance;
  }

  public async initializeAsync(
    modelPath?: string,
    dtype?: EmbeddingDtype,
    device?: EmbeddingDevice,
  ): Promise<void> {
    const requestedModelPath: string = modelPath ?? DEFAULT_EMBEDDING_MODEL;
    const requestedDtype: EmbeddingDtype = dtype ?? (DEFAULT_EMBEDDING_DTYPE as EmbeddingDtype);
    const requestedDevice: EmbeddingDevice = device ?? (DEFAULT_EMBEDDING_DEVICE as EmbeddingDevice);

    if (
      this._initialized &&
      this._modelPath === requestedModelPath &&
      this._dtype === requestedDtype
    ) {
      return;
    }

    if (this._initializationPromise) {
      await this._initializationPromise;
      return;
    }

    const initializeTask: Promise<void> = this._initializeInternalAsync(
      requestedModelPath,
      requestedDtype,
      requestedDevice,
    );

    this._initializationPromise = initializeTask;

    try {
      await initializeTask;
    } finally {
      this._initializationPromise = null;
    }
  }

  private async _initializeInternalAsync(
    requestedModelPath: string,
    requestedDtype: EmbeddingDtype,
    requestedDevice: EmbeddingDevice,
  ): Promise<void> {
    const logger: LoggerService = LoggerService.getInstance();

    this._modelPath = requestedModelPath;
    this._dtype = requestedDtype;

    this._device = await this._resolveDeviceAsync(requestedDevice);

    env.cacheDir = getModelsDir();

    logger.info("Loading embedding model...", {
      modelPath: this._modelPath,
      dtype: this._dtype,
      device: this._device,
    });

    try {
      await this._loadPipelineAsync();
    } catch (error: unknown) {
      if (this._isCorruptionError(error)) {
        logger.warn("Corrupted model cache detected. Clearing and re-downloading...", {
          modelPath: this._modelPath,
        });

        await this._clearModelCacheAsync();

        logger.info("Model cache cleared. Retrying download...", {
          modelPath: this._modelPath,
        });

        await this._loadPipelineAsync();
      } else {
        throw error;
      }
    }

    this._initialized = true;
  }

  public async embedAsync(text: string): Promise<number[]> {
    this._ensureInitialized();

    const statusService: StatusService = StatusService.getInstance();
    statusService.setStatus("embedding", "Generating embedding", {
      textLength: text.length,
    });

    try {
      const output: unknown = await this._pipeline!(text, {
        pooling: "mean",
        normalize: true,
      });
      const result: number[][] = (output as { tolist(): number[][] }).tolist();

      statusService.clearStatus();
      return result[0];
    } catch (error) {
      statusService.clearStatus();
      throw error;
    }
  }

  public async embedBatchAsync(texts: string[]): Promise<number[][]> {
    this._ensureInitialized();

    if (texts.length === 0) {
      return [];
    }

    const statusService: StatusService = StatusService.getInstance();
    statusService.setStatus("embedding", `Generating ${texts.length} embeddings`, {
      count: texts.length,
      totalChars: texts.reduce((sum, t) => sum + t.length, 0),
    });

    try {
      const output: unknown = await this._pipeline!(texts, {
        pooling: "mean",
        normalize: true,
      });
      const result: number[][] = (output as { tolist(): number[][] }).tolist();

      statusService.clearStatus();
      return result;
    } catch (error) {
      statusService.clearStatus();
      throw error;
    }
  }

  public getDimension(): number {
    return EMBEDDING_DIMENSION;
  }

  public getModelPath(): string {
    return this._modelPath;
  }

  //#endregion Public methods

  //#region Private methods

  private async _loadPipelineAsync(): Promise<void> {
    const logger: LoggerService = LoggerService.getInstance();
    const seenFiles: Set<string> = new Set<string>();
    let lastLoggedPercent: number = -1;

    this._pipeline = (await pipeline("feature-extraction", this._modelPath, {
      dtype: this._dtype,
      device: this._device,
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
          logger.info("Embedding model ready.", {
            modelPath: this._modelPath,
            dtype: this._dtype,
            device: this._device,
          });
        }
      },
    })) as FeatureExtractionPipeline;
  }

  private async _clearModelCacheAsync(): Promise<void> {
    const modelCacheDir: string = path.join(getModelsDir(), ...this._modelPath.split("/"));

    await rm(modelCacheDir, { recursive: true, force: true });
  }

  private _isCorruptionError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return CorruptionPatterns.some((pattern: RegExp): boolean => pattern.test(error.message));
  }

  private async _resolveDeviceAsync(device: EmbeddingDevice): Promise<PipelineDevice> {
    if (device !== "auto") {
      return device;
    }

    const logger: LoggerService = LoggerService.getInstance();

    if (await this._isCommandAvailableAsync("nvidia-smi")) {
      logger.info("GPU detected: NVIDIA. Using CUDA for embedding inference.");
      return "cuda";
    }

    if (await this._isCommandAvailableAsync("rocm-smi")) {
      logger.warn(
        "AMD GPU detected via rocm-smi, but @huggingface/transformers does not expose ROCm as a device. " +
        "Falling back to CPU. If you have a ROCm-compatible onnxruntime build, set embeddingDevice: cuda manually.",
      );
    }

    logger.info("No GPU detected. Using CPU for embedding inference.");
    return "cpu";
  }

  private async _isCommandAvailableAsync(command: string): Promise<boolean> {
    try {
      await _execAsync(`${command} --version`);
      return true;
    } catch {
      return false;
    }
  }

  private _ensureInitialized(): void {
    if (!this._initialized) {
      throw new Error(
        "EmbeddingService not initialized. Call initializeAsync() first.",
      );
    }
  }

  //#endregion Private methods
}
