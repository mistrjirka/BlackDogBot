import { ChatOpenAI } from "@langchain/openai";
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { IAiConfig } from "../shared/types/config.types.js";
import { LoggerService } from "./logger.service.js";
import { ChatOpenAICompletionsReasoning } from "./providers/chat-openai-completions-reasoning.js";
import { getModelProfilesDir } from "../utils/paths.js";
import { AiCapabilityService } from "./ai-capability.service.js";

//#region Public Functions

interface ICreateChatModelOptions {
  disableThinking?: boolean;
}

export function createChatModel(config: IAiConfig, options: ICreateChatModelOptions = {}): ChatOpenAI {
  const logger: LoggerService = LoggerService.getInstance();
  const { baseURL, apiKey, model, timeout } = _resolveProviderConfig(config);
  const modelKwargs: Record<string, unknown> = _resolveModelKwargs(config, options);
  const modelFields = {
    model,
    configuration: {
      baseURL,
      apiKey,
    },
    modelKwargs,
    temperature: 0.7,
    maxRetries: 3,
    timeout,
  };

  logger.info("LangChain model created", { provider: config.provider, model, baseURL });

  return new ChatOpenAI({
    ...modelFields,
    completions:
      config.provider === "openai-compatible" || config.provider === "lm-studio"
        ? new ChatOpenAICompletionsReasoning(modelFields)
        : undefined,
  });
}

//#endregion Public Functions

//#region Private Functions

interface IResolvedProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  timeout: number;
}

interface IModelProfileDefaults {
  reasoningFormat?: string;
  parallelToolCalls?: boolean;
  disableThinkingOnRetry?: boolean;
  chatTemplateKwargs?: Record<string, unknown>;
}

interface IModelProfileYaml {
  activePatches?: string[];
  defaults?: IModelProfileDefaults;
}

function _resolveProviderConfig(config: IAiConfig): IResolvedProviderConfig {
  const defaultTimeout: number = 500000;

  if (config.provider === "openrouter" && config.openrouter) {
    return {
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: config.openrouter.apiKey,
      model: config.openrouter.model,
      timeout: defaultTimeout,
    };
  }

  if (config.provider === "openai-compatible" && config.openaiCompatible) {
    return {
      baseURL: config.openaiCompatible.baseUrl,
      apiKey: config.openaiCompatible.apiKey,
      model: config.openaiCompatible.model,
      timeout: config.openaiCompatible.requestTimeout ?? defaultTimeout,
    };
  }

  if (config.provider === "lm-studio" && config.lmStudio) {
    return {
      baseURL: config.lmStudio.baseUrl,
      apiKey: config.lmStudio.apiKey ?? "lm-studio",
      model: config.lmStudio.model,
      timeout: config.lmStudio.requestTimeout ?? defaultTimeout,
    };
  }

  throw new Error(`No provider configuration found for: ${config.provider}`);
}

function _resolveModelKwargs(config: IAiConfig, options: ICreateChatModelOptions): Record<string, unknown> {
  const profileContext = _resolveProfileContext(config);
  const modelKwargs: Record<string, unknown> = {};

  if (profileContext !== null) {
    const profileData = _loadProfileYaml(profileContext.profileName, profileContext.profilesDir);
    if (profileData !== null && typeof profileData.defaults === "object" && profileData.defaults !== null) {
      const defaults: IModelProfileDefaults = profileData.defaults;

      if (typeof defaults.reasoningFormat === "string" && defaults.reasoningFormat.length > 0) {
        modelKwargs.reasoning_format = defaults.reasoningFormat;
      }

      if (typeof defaults.parallelToolCalls === "boolean") {
        modelKwargs.parallel_tool_calls = defaults.parallelToolCalls;
      }

      if (typeof defaults.chatTemplateKwargs === "object" && defaults.chatTemplateKwargs !== null) {
        modelKwargs.chat_template_kwargs = {
          ...defaults.chatTemplateKwargs,
        };
      }
    }
  }

  // If profile didn't set parallel_tool_calls, check capability service
  if (modelKwargs.parallel_tool_calls === undefined) {
    const supported = AiCapabilityService.getInstance().getSupportsParallelToolCalls();
    if (supported) {
      modelKwargs.parallel_tool_calls = true;
    }
  }

  if (options.disableThinking) {
    const currentChatTemplateKwargs: Record<string, unknown> =
      typeof modelKwargs.chat_template_kwargs === "object" &&
      modelKwargs.chat_template_kwargs !== null
        ? modelKwargs.chat_template_kwargs as Record<string, unknown>
        : {};

    modelKwargs.chat_template_kwargs = {
      ...currentChatTemplateKwargs,
      enable_thinking: false,
    };
  }

  return modelKwargs;
}

function _resolveProfileContext(config: IAiConfig): { profileName: string; profilesDir: string } | null {
  const provider = config.provider;

  if (provider === "openai-compatible") {
    const providerConfig = config.openaiCompatible;
    if (!providerConfig?.activeProfile) {
      return null;
    }

    return {
      profileName: providerConfig.activeProfile,
      profilesDir: providerConfig.profilesDir ?? getModelProfilesDir(),
    };
  }

  if (provider === "lm-studio") {
    const providerConfig = config.lmStudio;
    if (!providerConfig?.activeProfile) {
      return null;
    }

    return {
      profileName: providerConfig.activeProfile,
      profilesDir: providerConfig.profilesDir ?? getModelProfilesDir(),
    };
  }

  if (provider === "openrouter") {
    const providerConfig = config.openrouter;
    if (!providerConfig?.activeProfile) {
      return null;
    }

    return {
      profileName: providerConfig.activeProfile,
      profilesDir: providerConfig.profilesDir ?? getModelProfilesDir(),
    };
  }

  return null;
}

function _loadProfileYaml(profileName: string, profilesDir: string): IModelProfileYaml | null {
  const userProfilePath: string = path.join(profilesDir, `${profileName}.yaml`);
  const builtInProfilePath: string = path.resolve(process.cwd(), "src", "defaults", "model-profiles", `${profileName}.yaml`);

  const pathsToTry: string[] = [userProfilePath, builtInProfilePath];

  for (const profilePath of pathsToTry) {
    if (!fs.existsSync(profilePath)) {
      continue;
    }

    try {
      const rawContent: string = fs.readFileSync(profilePath, "utf-8");
      const parsed: unknown = parseYaml(rawContent);
      if (typeof parsed === "object" && parsed !== null) {
        return parsed as IModelProfileYaml;
      }
    } catch {
      continue;
    }
  }

  return null;
}

//#endregion Private Functions
