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
  DEFAULT_EMBEDDING_PROVIDER,
  DEFAULT_OPENROUTER_EMBEDDING_MODEL,
  DEFAULT_LOCAL_EMBEDDING_FALLBACK_MODEL,
  EMBEDDING_DIMENSION,
} from "../shared/constants.js";
import type {
  EmbeddingDevice,
  EmbeddingDtype,
  EmbeddingProvider,
} from "../shared/types/index.js";
import { LoggerService } from "./logger.service.js";
import { StatusService } from "./status.service.js";
import { getModelsDir } from "../utils/paths.js";
import { fetchWithTimeout } from "../utils/fetch-with-timeout.js";

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
  private _provider: EmbeddingProvider;
  private _modelPath: string;
  private _dtype: EmbeddingDtype;
  private _device: PipelineDevice;
  private _openRouterModel: string;
  private _openRouterApiKey: string;
  private _dimension: number;
  private _initialized: boolean;
  private _initializationPromise: Promise<void> | null;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._pipeline = null;
    this._provider = "local";
    this._modelPath = "";
    this._dtype = "q8";
    this._device = "cpu";
    this._openRouterModel = "";
    this._openRouterApiKey = "";
    this._dimension = EMBEDDING_DIMENSION;
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
    provider?: EmbeddingProvider,
    openRouterModel?: string,
    openRouterApiKey?: string,
  ): Promise<void> {
    const requestedProvider: EmbeddingProvider = provider ?? (DEFAULT_EMBEDDING_PROVIDER as EmbeddingProvider);
    const requestedModelPath: string = modelPath ?? DEFAULT_EMBEDDING_MODEL;
    const requestedDtype: EmbeddingDtype = dtype ?? (DEFAULT_EMBEDDING_DTYPE as EmbeddingDtype);
    const requestedDevice: EmbeddingDevice = device ?? (DEFAULT_EMBEDDING_DEVICE as EmbeddingDevice);
    const requestedOpenRouterModel: string =
      openRouterModel ?? DEFAULT_OPENROUTER_EMBEDDING_MODEL;
    const requestedOpenRouterApiKey: string =
      openRouterApiKey ?? process.env.OPENROUTER_API_KEY ?? "";
    const normalizedOpenRouterModel: string =
      this._normalizeOpenRouterModel(requestedOpenRouterModel);

    if (
      this._initialized &&
      this._provider === requestedProvider &&
      this._modelPath === requestedModelPath &&
      this._dtype === requestedDtype &&
      this._device === (requestedDevice === "auto" ? this._device : requestedDevice) &&
      this._openRouterModel === normalizedOpenRouterModel
    ) {
      return;
    }

    if (this._initializationPromise) {
      await this._initializationPromise;
      return;
    }

    const initializeTask: Promise<void> = this._initializeInternalAsync(
      requestedProvider,
      requestedModelPath,
      requestedDtype,
      requestedDevice,
      normalizedOpenRouterModel,
      requestedOpenRouterApiKey,
    );

    this._initializationPromise = initializeTask;

    try {
      await initializeTask;
    } finally {
      this._initializationPromise = null;
    }
  }

  private async _initializeInternalAsync(
    requestedProvider: EmbeddingProvider,
    requestedModelPath: string,
    requestedDtype: EmbeddingDtype,
    requestedDevice: EmbeddingDevice,
    requestedOpenRouterModel: string,
    requestedOpenRouterApiKey: string,
  ): Promise<void> {
    const logger: LoggerService = LoggerService.getInstance();

    this._provider = requestedProvider;
    this._modelPath = requestedModelPath;
    this._dtype = requestedDtype;
    this._openRouterModel = requestedOpenRouterModel;
    this._openRouterApiKey = requestedOpenRouterApiKey;

    if (this._provider === "openrouter") {
      if (!this._openRouterApiKey) {
        throw new Error(
          "OpenRouter embedding provider requires an API key. " +
            "Set knowledge.embeddingOpenRouterApiKey or OPENROUTER_API_KEY.",
        );
      }

      logger.info("Initializing OpenRouter embedding provider...", {
        model: this._openRouterModel,
      });

      const probeEmbeddings: number[][] = await this._embedWithOpenRouterAsync([
        "embedding dimension probe",
      ]);

      if (probeEmbeddings.length === 0 || probeEmbeddings[0].length === 0) {
        throw new Error("OpenRouter embedding API returned empty vectors.");
      }

      this._dimension = probeEmbeddings[0].length;
      this._device = "cpu";
      this._pipeline = null;
      this._initialized = true;

      logger.info("OpenRouter embedding provider initialized.", {
        model: this._openRouterModel,
        dimension: this._dimension,
      });

      return;
    }

    this._device = await this._resolveDeviceAsync(requestedDevice);

    env.cacheDir = getModelsDir();
    
    // Explicitly configure ONNX execution providers to prevent onnxruntime-node from 
    // crashing when probing for missing CUDA libraries on CPU fallback.
    // Ensure env.backends.onnx exists first.
    const backends = env.backends as any;
    if (!backends) (env as any).backends = {};
    if (!(env.backends as any).onnx) (env.backends as any).onnx = {};
    
    // Onnxruntime-node attempts to load all available providers (including CUDA) by default.
    // When CUDA libraries are missing, this causes a fatal crash even if device='cpu' is passed to pipeline.
    // By strictly limiting the executionProviders, we bypass this issue.
    if (this._device === "cuda") {
        (env.backends as any).onnx.executionProviders = ['cuda', 'cpu'];
    } else {
        (env.backends as any).onnx.executionProviders = ['cpu'];
    }

    logger.info("Loading embedding model...", {
      modelPath: this._modelPath,
      dtype: this._dtype,
      device: this._device,
    });

    try {
      await this._loadPipelineAsync();
    } catch (error: unknown) {
      if (
        this._modelPath === DEFAULT_EMBEDDING_MODEL &&
        this._shouldFallbackToDefaultLocalModel(error)
      ) {
        logger.warn(
          "Default local embedding model failed to load in current Transformers.js runtime. " +
            "Falling back to compatible multilingual model.",
          {
            requestedModel: this._modelPath,
            fallbackModel: DEFAULT_LOCAL_EMBEDDING_FALLBACK_MODEL,
            error: error instanceof Error ? error.message : String(error),
          },
        );

        this._modelPath = DEFAULT_LOCAL_EMBEDDING_FALLBACK_MODEL;
        await this._loadPipelineAsync();
      } else if (this._isCorruptionError(error)) {
        logger.warn("Corrupted model cache detected. Clearing and re-downloading...", {
          modelPath: this._modelPath,
        });

        await this._clearModelCacheAsync();

        logger.info("Model cache cleared. Retrying download...", {
          modelPath: this._modelPath,
        });

        await this._loadPipelineAsync();
      } else if (
        this._device === "cuda" &&
        error instanceof Error &&
        (error.message.includes("libonnxruntime_providers_cuda") ||
          error.message.includes("cannot open shared object file"))
      ) {
        logger.warn(
          "Failed to load CUDA providers (missing libraries). Falling back to CPU inference. " +
          "To enable GPU acceleration, please install the CUDA 12 toolkit (e.g., sudo pacman -S cuda).",
          { error: error.message }
        );
        this._device = "cpu";
        await this._loadPipelineAsync();
      } else {
        throw error;
      }
    }

    const probeOutput: unknown = await this._pipeline!("embedding dimension probe", {
      pooling: "mean",
      normalize: true,
    });
    const probeVectors: number[][] = (probeOutput as { tolist(): number[][] }).tolist();

    if (probeVectors.length > 0) {
      this._dimension = probeVectors[0].length;
    }

    this._initialized = true;
  }

  public async embedAsync(text: string): Promise<number[]> {
    this._ensureInitialized();

    const statusService: StatusService = StatusService.getInstance();
    statusService.setStatus("embedding", "Generating embedding", {
      textLength: text.length,
      provider: this._provider,
    });

    try {
      if (this._provider === "openrouter") {
        const result: number[][] = await this._embedWithOpenRouterAsync([text]);

        statusService.clearStatus();
        return result[0];
      }

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
      provider: this._provider,
    });

    try {
      if (this._provider === "openrouter") {
        const result: number[][] = await this._embedWithOpenRouterAsync(texts);

        statusService.clearStatus();
        return result;
      }

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
    return this._dimension;
  }

  public getModelPath(): string {
    if (this._provider === "openrouter") {
      return this._openRouterModel;
    }

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
      if (process.platform === "linux") {
        // onnxruntime-node 1.x ships pre-built binaries linked against CUDA 12.
        // It requires libcublasLt.so.12, libcufft.so.11, libcudnn.so.9, etc.
        // If the system has CUDA 13+ (e.g. Arch Linux), those .so.12 libs won't
        // exist and onnxruntime will crash fatally at native addon load time.
        //
        // We check if the critical CUDA 12 libraries are available either via
        // ldconfig or in LD_LIBRARY_PATH (which scripts/launch.sh may have set).
        const hasCuda12 = await this._hasCuda12LibsAsync();

        if (hasCuda12) {
          logger.info("GPU detected: NVIDIA with CUDA 12 libraries available. Using CUDA.");
          return "cuda";
        }

        logger.warn(
          "NVIDIA GPU detected, but onnxruntime-node requires CUDA 12 libraries " +
          "(libcublasLt.so.12, libcufft.so.11, etc.) which were not found. " +
          "Falling back to CPU. To enable GPU inference, install a CUDA 12 compat package " +
          "or set embeddingDevice: cpu in config to silence this warning.",
        );
        return "cpu";
      }

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

  /**
   * Checks if the core CUDA 12 libraries that onnxruntime-node needs are
   * discoverable by the dynamic linker (via ldconfig or LD_LIBRARY_PATH).
   */
  private async _hasCuda12LibsAsync(): Promise<boolean> {
    // The minimum set onnxruntime-node 1.21 needs from CUDA 12
    const requiredLibs = ["libcublasLt.so.12", "libcufft.so.11"];

    for (const lib of requiredLibs) {
      const found = await this._isLibAvailableAsync(lib);
      if (!found) {
        return false;
      }
    }

    return true;
  }

  /** Checks if a shared library is findable via ldconfig or LD_LIBRARY_PATH */
  private async _isLibAvailableAsync(libName: string): Promise<boolean> {
    // 1. Check ldconfig cache
    try {
      await _execAsync(`ldconfig -p | grep '${libName}'`);
      return true;
    } catch {
      // not in ldconfig
    }

    // 2. Check LD_LIBRARY_PATH directories (launch.sh may have set this)
    const ldPaths = (process.env["LD_LIBRARY_PATH"] ?? "").split(":").filter(Boolean);
    const { existsSync } = await import("fs");

    for (const dir of ldPaths) {
      try {
        if (existsSync(path.join(dir, libName))) {
          return true;
        }
      } catch {
        // skip
      }
    }

    return false;
  }

  private async _isCommandAvailableAsync(command: string): Promise<boolean> {
    try {
      await _execAsync(`${command} --version`);
      return true;
    } catch {
      return false;
    }
  }

  private _shouldFallbackToDefaultLocalModel(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    const message: string = error.message.toLowerCase();

    return (
      message.includes("onnx/model_quantized.onnx") ||
      message.includes("unauthorized access to file") ||
      message.includes("protobuf parsing failed")
    );
  }

  private _normalizeOpenRouterModel(model: string): string {
    const fromHttpsPrefix = "https://openrouter.ai/";
    const fromHttpPrefix = "http://openrouter.ai/";

    if (model.startsWith(fromHttpsPrefix)) {
      return model.slice(fromHttpsPrefix.length).replace(/^\/+/, "");
    }

    if (model.startsWith(fromHttpPrefix)) {
      return model.slice(fromHttpPrefix.length).replace(/^\/+/, "");
    }

    return model;
  }

  private async _embedWithOpenRouterAsync(texts: string[]): Promise<number[][]> {
    const response: Response = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/embeddings",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this._openRouterApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this._openRouterModel,
          input: texts,
        }),
      },
      60000,
    );

    if (!response.ok) {
      const errorBody: string = await response.text();
      throw new Error(`OpenRouter embedding request failed (${response.status}): ${errorBody}`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };

    if (!payload.data || !Array.isArray(payload.data)) {
      throw new Error("OpenRouter embedding response missing data array.");
    }

    const vectors: number[][] = payload.data.map((item): number[] => {
      if (!item.embedding || !Array.isArray(item.embedding)) {
        throw new Error("OpenRouter embedding response contains invalid vector.");
      }

      return item.embedding;
    });

    return vectors;
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
