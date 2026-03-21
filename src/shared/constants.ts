//#region Path Constants

export const BASE_DIR_NAME: string = ".betterclaw";
export const CONFIG_FILE_NAME: string = "config.yaml";
export const SKILL_FILE_NAME: string = "SKILL.md";
export const SKILL_STATE_FILE_NAME: string = "state.json";
export const JOB_FILE_NAME: string = "job.json";

//#endregion Path Constants

//#region Directory Names

export const KNOWLEDGE_DIR: string = "knowledge";
export const LANCEDB_DIR: string = "lancedb";
export const CRON_DIR: string = "cron";

//#endregion Directory Names

//#region Defaults

export const DEFAULT_EMBEDDING_MODEL: string = "onnx-community/Qwen3-Embedding-0.6B-ONNX";
export const DEFAULT_EMBEDDING_DTYPE: string = "q8";
export const DEFAULT_EMBEDDING_DEVICE: string = "auto";
export const EMBEDDING_DIMENSION: number = 768;
export const DEFAULT_EMBEDDING_PROVIDER: string = "local";
export const DEFAULT_OPENROUTER_EMBEDDING_MODEL: string = "https://openrouter.ai/nvidia/llama-nemotron-embed-vl-1b-v2:free";
export const DEFAULT_LOCAL_EMBEDDING_FALLBACK_MODEL: string = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const DEFAULT_KNOWLEDGE_COLLECTION: string = "default";
export const DEFAULT_MAX_SEARCH_RESULTS: number = 10;

export const DEFAULT_RPM: number = 60;
export const DEFAULT_TPM: number = 100000;

export const DEFAULT_AGENT_MAX_STEPS: number = 300;
export const FORCE_THINK_INTERVAL: number = 5;
export const DEFAULT_CMD_TIMEOUT_MS: number = 30000;
export const DEFAULT_PYTHON_TIMEOUT_MS: number = 30000;

export const ID_LENGTH: number = 12;

//#endregion Defaults

//#region Prompt Names

export const PROMPT_MAIN_AGENT: string = "main-agent";
export const PROMPT_CRON_AGENT: string = "cron-agent";
export const PROMPT_JOB_AGENT: string = "job-agent";
export const PROMPT_AGENT_NODE_GUIDE: string = "agent-node-guide";
export const PROMPT_SKILL_SETUP: string = "skill-setup";
export const PROMPT_JOB_CREATION_GUIDE: string = "job-creation-guide";
export const PROMPT_TOOL_PREAMBLES: string = "tool-preambles";
export const PROMPT_CONTEXT_GATHERING: string = "context-gathering";
export const PROMPT_PERSISTENCE: string = "persistence";

//#endregion Prompt Names

//#region Include Directive

export const INCLUDE_DIRECTIVE_REGEX: RegExp = /\{\{include:(.+?)\}\}/g;

//#endregion Include Directive
