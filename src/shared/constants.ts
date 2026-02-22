//#region Path Constants

export const BASE_DIR_NAME: string = ".betterclaw";
export const CONFIG_FILE_NAME: string = "config.yaml";
export const SKILL_FILE_NAME: string = "SKILL.md";
export const SKILL_STATE_FILE_NAME: string = "state.json";
export const JOB_FILE_NAME: string = "job.json";

//#endregion Path Constants

//#region Directory Names

export const SKILLS_DIR: string = "skills";
export const JOBS_DIR: string = "jobs";
export const NODES_DIR: string = "nodes";
export const TESTS_DIR: string = "tests";
export const KNOWLEDGE_DIR: string = "knowledge";
export const LANCEDB_DIR: string = "lancedb";
export const CRON_DIR: string = "cron";
export const LOGS_DIR: string = "logs";
export const PROMPTS_DIR: string = "prompts";
export const WORKSPACE_DIR: string = "workspace";
export const RSS_STATE_DIR: string = "rss-state";
export const PROMPT_FRAGMENTS_DIR: string = "prompt-fragments";
export const DEFAULTS_DIR: string = "defaults";

//#endregion Directory Names

//#region Defaults

export const DEFAULT_EMBEDDING_MODEL: string = "Xenova/bge-m3";
export const DEFAULT_EMBEDDING_DTYPE: string = "q8";
export const DEFAULT_EMBEDDING_DEVICE: string = "auto";
export const EMBEDDING_DIMENSION: number = 1024;
export const DEFAULT_KNOWLEDGE_COLLECTION: string = "default";
export const DEFAULT_MAX_SEARCH_RESULTS: number = 10;

export const DEFAULT_RPM: number = 60;
export const DEFAULT_TPM: number = 100000;

export const DEFAULT_AGENT_MAX_STEPS: number = 40;
export const FORCE_THINK_INTERVAL: number = 5;
export const DEFAULT_CMD_TIMEOUT_MS: number = 30000;
export const DEFAULT_PYTHON_TIMEOUT_MS: number = 30000;
export const DEFAULT_NODE_TEST_TIMEOUT_MS: number = 60000;

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
