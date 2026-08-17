//#region Path Constants

export const SKILL_FILE_NAME: string = "SKILL.md";

//#endregion Path Constants

//#region Directory Names


//#endregion Directory Names

//#region Defaults

export const HARD_GATE_THRESHOLD_PERCENTAGE: number = 0.85;

export const DEFAULT_EMBEDDING_MODEL: string = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
export const DEFAULT_EMBEDDING_DTYPE: string = "q8";
export const DEFAULT_EMBEDDING_DEVICE: string = "auto";
export const EMBEDDING_DIMENSION: number = 768;
export const DEFAULT_EMBEDDING_PROVIDER: string = "local";
export const DEFAULT_OPENROUTER_EMBEDDING_MODEL: string = "https://openrouter.ai/nvidia/llama-nemotron-embed-vl-1b-v2:free";
export const DEFAULT_LOCAL_EMBEDDING_FALLBACK_MODEL: string = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const DEFAULT_KNOWLEDGE_COLLECTION: string = "default";

export const DEFAULT_RPM: number = 60;
export const DEFAULT_TPM: number = 100000;

export const DEFAULT_AGENT_MAX_STEPS: number = 300;
export const MAX_DELEGATE_AGENT_OUTPUT_LENGTH: number = 100_000;


//#endregion Defaults

//#region Prompt Names

export const PROMPT_MAIN_AGENT: string = "main-agent";
export const PROMPT_CRON_AGENT: string = "cron-agent";

//#endregion Prompt Names

//#region Include Directive

export const INCLUDE_DIRECTIVE_REGEX: RegExp = /\{\{include:(.+?)\}\}/g;

//#endregion Include Directive

//#region Install Kinds

export const ALLOWED_INSTALL_KINDS = ["brew", "node", "go", "uv", "pacman", "apt", "download"] as const;
export type AllowedInstallKind = (typeof ALLOWED_INSTALL_KINDS)[number];
export const DEFAULT_ALLOWED_INSTALL_KINDS: AllowedInstallKind[] = ["brew", "node", "go", "uv"];
export const DEFAULT_SKILL_INSTALL_TIMEOUT_MS: number = 300000;
export const MAX_SKILL_INSTALL_STEPS: number = 32;
export const DEPENDENCY_CHECK_CACHE_TTL_MS: number = 60000;
export const MAX_DEPENDENCY_CHECKS_PER_REFRESH: number = 1024;
export const MAX_DEPENDENCY_CACHE_ENTRIES: number = 1024;

//#endregion Install Kinds

//#region Skill Setup Limits

export const MAX_AUTO_SETUP_ATTEMPTS: number = 3;
export const MAX_SETUP_ERROR_LENGTH: number = 2000;
export const MAX_SETUP_ERROR_PREVIEW_LENGTH: number = 500;
export const MAX_MANUAL_STEP_INSTRUCTION_LENGTH: number = 1200;
export const MAX_SKILLS_PER_ROOT: number = 256;
export const MAX_SKILL_WATCHERS: number = 512;

//#endregion Skill Setup Limits
