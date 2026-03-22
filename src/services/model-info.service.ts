import { LoggerService } from "./logger.service.js";
import { extractErrorMessage } from "../utils/error.js";

//#region Interfaces

interface IOpenRouterModel {
  id: string;
  context_length?: number;
  supported_parameters?: string[];
  architecture?: {
    input_modalities?: string[];
  };
}

interface IOpenRouterModelsResponse {
  data: IOpenRouterModel[];
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
  private _supportedParametersCache: Map<string, Set<string>>;
  private _inputModalitiesCache: Map<string, Set<string>>;
  private _modelsFetched: boolean;
  private _fetchPromise: Promise<void> | null;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._logger = LoggerService.getInstance();
    this._contextWindowCache = new Map<string, number>();
    this._supportedParametersCache = new Map<string, Set<string>>();
    this._inputModalitiesCache = new Map<string, Set<string>>();
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
   * Fetches supported parameters for a model from OpenRouter API.
   * Returns null when capabilities are unavailable.
   */
  public async fetchSupportedParametersAsync(modelId: string): Promise<Set<string> | null> {
    const cached: Set<string> | undefined = this._getCachedSupportedParameters(modelId);
    if (cached) {
      return new Set<string>(cached);
    }

    if (!this._modelsFetched) {
      await this._ensureModelsFetchedAsync();
    }

    const cachedAfterFetch: Set<string> | undefined = this._getCachedSupportedParameters(modelId);
    if (cachedAfterFetch) {
      return new Set<string>(cachedAfterFetch);
    }

    this._logger.warn("Model capabilities not found in OpenRouter API response", { modelId });
    return null;
  }

  /**
   * Gets cached supported parameters without making API calls.
   */
  public getCachedSupportedParameters(modelId: string): Set<string> | null {
    const cached: Set<string> | undefined = this._getCachedSupportedParameters(modelId);
    return cached ? new Set<string>(cached) : null;
  }

  /**
   * Detects whether a model supports image input based on OpenRouter metadata.
   * Returns null when metadata is unavailable.
   */
  public async fetchSupportsImagesAsync(modelId: string): Promise<boolean | null> {
    const cached: Set<string> | undefined = this._getCachedInputModalities(modelId);
    if (cached) {
      return cached.has("image");
    }

    if (!this._modelsFetched) {
      await this._ensureModelsFetchedAsync();
    }

    const cachedAfterFetch: Set<string> | undefined = this._getCachedInputModalities(modelId);
    if (cachedAfterFetch) {
      return cachedAfterFetch.has("image");
    }

    this._logger.warn("Model modalities not found in OpenRouter API response", { modelId });
    return null;
  }

  /**
   * Clears the model info cache.
   */
  public clearCache(): void {
    this._contextWindowCache.clear();
    this._supportedParametersCache.clear();
    this._inputModalitiesCache.clear();
    this._modelsFetched = false;
    this._fetchPromise = null;
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

        if (model.id && Array.isArray(model.supported_parameters)) {
          this._supportedParametersCache.set(
            model.id,
            new Set<string>(
              model.supported_parameters
                .filter((value: string): boolean => typeof value === "string")
                .map((value: string): string => value.toLowerCase()),
            ),
          );
        }

        if (model.id && Array.isArray(model.architecture?.input_modalities)) {
          this._inputModalitiesCache.set(
            model.id,
            new Set<string>(
              model.architecture.input_modalities
                .filter((value: string): boolean => typeof value === "string")
                .map((value: string): string => value.toLowerCase()),
            ),
          );
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

  private _getCachedSupportedParameters(modelId: string): Set<string> | undefined {
    const exact: Set<string> | undefined = this._supportedParametersCache.get(modelId);
    if (exact) {
      return exact;
    }

    const baseModelId: string = modelId.split(":")[0] ?? modelId;
    return this._supportedParametersCache.get(baseModelId);
  }

  private _getCachedInputModalities(modelId: string): Set<string> | undefined {
    const exact: Set<string> | undefined = this._inputModalitiesCache.get(modelId);
    if (exact) {
      return exact;
    }

    const baseModelId: string = modelId.split(":")[0] ?? modelId;
    return this._inputModalitiesCache.get(baseModelId);
  }

  //#endregion Private methods
}

//#endregion ModelInfoService
