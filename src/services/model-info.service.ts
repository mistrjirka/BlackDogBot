import { LoggerService } from "./logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

function normalizeBaseUrl(url: string): string {
  const trimmed: string = url.trim();
  return trimmed.replace(/\/v1\/?$/, "");
}

//#region Interfaces

interface IOpenRouterModel {
  id: string;
  context_length?: number;
}

interface IOpenRouterModelsResponse {
  data: IOpenRouterModel[];
}

interface ILmStudioModel {
  id: string;
  max_context_length?: number;
  loaded_context_length?: number;
  state?: string;
}

interface ILmStudioModelsResponse {
  data?: ILmStudioModel[];
}

//#endregion Interfaces

//#region ModelInfoService

/**
 * Service for fetching model information from OpenRouter API.
 * Caches results to avoid repeated API calls.
 */
export class ModelInfoService {
  //#region Data members

  private static _instance: ModelInfoService | null;
  private _logger: LoggerService;
  private _contextWindowCache: Map<string, number>;
  private _modelsFetched: boolean;
  private _fetchPromise: Promise<void> | null;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._contextWindowCache = new Map<string, number>();
    this._modelsFetched = false;
    this._fetchPromise = null;
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): ModelInfoService {
    if (!ModelInfoService._instance) {
      ModelInfoService._instance = new ModelInfoService();
    }

    return ModelInfoService._instance;
  }

  /**
   * Fetches the context window for a model from OpenRouter API.
   * Results are cached to avoid repeated API calls.
   * 
   * @param modelId - The model ID (e.g., "anthropic/claude-sonnet-4")
   * @returns The context window size in tokens, defaults to 128000 if not found
   */
  public async fetchContextWindowAsync(modelId: string): Promise<number> {
    // Check cache first
    const cached: number | undefined = this._contextWindowCache.get(modelId);

    if (cached !== undefined) {
      return cached;
    }

    // If models haven't been fetched yet, fetch them
    if (!this._modelsFetched) {
      await this._ensureModelsFetchedAsync();
    }

    // Check cache again after fetch
    const cachedAfterFetch: number | undefined = this._contextWindowCache.get(modelId);

    if (cachedAfterFetch !== undefined) {
      return cachedAfterFetch;
    }

    // Model not found in API response, use default
    this._logger.warn("Model not found in OpenRouter API, using default context window", {
      modelId,
      defaultWindow: 128_000,
    });

    return 128_000;
  }

  /**
   * Gets cached context window without making API calls.
   * Returns undefined if not cached.
   */
  public getCachedContextWindow(modelId: string): number | undefined {
    return this._contextWindowCache.get(modelId);
  }

  /**
   * Clears the model info cache.
   */
  public clearCache(): void {
    this._contextWindowCache.clear();
    this._modelsFetched = false;
    this._fetchPromise = null;
  }

  /**
   * Fetches context window from LM Studio native API.
   * Uses loaded_context_length if available, falls back to max_context_length.
   * 
   * @param baseUrl - The LM Studio base URL (e.g., http://localhost:1234)
   * @param modelId - The model ID to look up
   * @returns The loaded context length, or null if not found
   */
  public async fetchLmStudioContextWindowAsync(
    baseUrl: string,
    modelId: string,
  ): Promise<{ loaded: number | null; max: number | null }> {
    try {
      this._logger.debug("Fetching model info from LM Studio API", { baseUrl, modelId });

      const normalizedBaseUrl: string = normalizeBaseUrl(baseUrl);
      const response: Response = await fetch(`${normalizedBaseUrl}/api/v0/models`, {
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        this._logger.warn("Failed to fetch models from LM Studio API", {
          status: response.status,
          statusText: response.statusText,
        });

        return { loaded: null, max: null };
      }

      const data: ILmStudioModelsResponse = await response.json() as ILmStudioModelsResponse;

      if (!data.data || !Array.isArray(data.data)) {
        this._logger.warn("Invalid response format from LM Studio API");

        return { loaded: null, max: null };
      }

      const model: ILmStudioModel | undefined = data.data.find((m) => m.id === modelId);

      if (!model) {
        this._logger.warn("Model not found in LM Studio API response", { modelId });

        return { loaded: null, max: null };
      }

      const loadedContext = model.loaded_context_length ?? null;
      const maxContext = model.max_context_length ?? null;

      if (loadedContext && maxContext && loadedContext < maxContext) {
        this._logger.info(
          `Model loaded with ${loadedContext} context but supports up to ${maxContext}. ` +
          `Increase context length in LM Studio for better performance with long conversations.`
        );
      }

      this._logger.debug("LM Studio model info fetched", {
        modelId,
        loadedContext,
        maxContext,
        state: model.state,
      });

      return { loaded: loadedContext, max: maxContext };
    } catch (error: unknown) {
      this._logger.warn("Error fetching model info from LM Studio API", {
        error: extractErrorMessage(error),
      });

      return { loaded: null, max: null };
    }
  }

  //#endregion Public methods

  //#region Private methods

  private async _ensureModelsFetchedAsync(): Promise<void> {
    // If a fetch is already in progress, wait for it
    if (this._fetchPromise) {
      return this._fetchPromise;
    }

    // Start a new fetch
    this._fetchPromise = this._fetchModelsAsync();

    try {
      await this._fetchPromise;
    } finally {
      this._fetchPromise = null;
    }
  }

  private async _fetchModelsAsync(): Promise<void> {
    try {
      this._logger.debug("Fetching model info from OpenRouter API");

      const response: Response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: {
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        this._logger.warn("Failed to fetch models from OpenRouter API", {
          status: response.status,
          statusText: response.statusText,
        });
        return;
      }

      const data: IOpenRouterModelsResponse = await response.json() as IOpenRouterModelsResponse;

      if (!data.data || !Array.isArray(data.data)) {
        this._logger.warn("Invalid response format from OpenRouter API");
        return;
      }

      // Populate cache with context lengths
      for (const model of data.data) {
        if (model.id && model.context_length !== undefined) {
          this._contextWindowCache.set(model.id, model.context_length);
        }
      }

      this._modelsFetched = true;
      this._logger.debug("Fetched model info from OpenRouter API", {
        modelCount: this._contextWindowCache.size,
      });
    } catch (error: unknown) {
      this._logger.error("Error fetching models from OpenRouter API", {
        error: extractErrorMessage(error),
      });
    }
  }

  //#endregion Private methods
}

//#endregion ModelInfoService
