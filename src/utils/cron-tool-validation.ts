import { CRON_VALID_TOOL_NAMES } from "../shared/schemas/tool-schemas.js";

const _DYNAMIC_TABLE_PREFIXES: readonly string[] = ["write_table_", "update_table_"] as const;

const _DYNAMIC_SUFFIX_REGEX: RegExp = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function isDynamicTableToolName(toolName: string): boolean {
  for (const prefix of _DYNAMIC_TABLE_PREFIXES) {
    if (toolName.startsWith(prefix)) {
      const suffix: string = toolName.slice(prefix.length);
      return _DYNAMIC_SUFFIX_REGEX.test(suffix);
    }
  }
  return false;
}

export function filterInvalidTools(tools: string[]): string[] {
  const validToolSet: ReadonlySet<string> = new Set(CRON_VALID_TOOL_NAMES);
  return tools.filter((t) => !validToolSet.has(t) && !isDynamicTableToolName(t));
}