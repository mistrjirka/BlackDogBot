import { CRON_TOOL_DESCRIPTIONS } from "../shared/constants/cron-descriptions.js";
import { buildPerTableToolsAsync, buildUpdateTableToolsAsync } from "./per-table-tools.js";
import { LoggerService } from "../services/logger.service.js";

export async function buildCronToolContextBlockAsync(tools: string[]): Promise<string> {
  const logger: LoggerService = LoggerService.getInstance();
  const dynamicWriteToolDescriptions: Map<string, string> = new Map();
  const dynamicUpdateToolDescriptions: Map<string, string> = new Map();

  try {
    const [perTableTools, updateTableTools] = await Promise.all([
      buildPerTableToolsAsync(),
      buildUpdateTableToolsAsync(),
    ]);
    for (const [toolName, toolDef] of Object.entries(perTableTools)) {
      if (typeof toolDef.description === "string" && toolDef.description.trim().length > 0) {
        dynamicWriteToolDescriptions.set(toolName, toolDef.description);
      }
    }
    for (const [toolName, toolDef] of Object.entries(updateTableTools)) {
      if (typeof toolDef.description === "string" && toolDef.description.trim().length > 0) {
        dynamicUpdateToolDescriptions.set(toolName, toolDef.description);
      }
    }
  } catch (err) {
    logger.warn("[cron-tool-context] Failed to build dynamic table tool descriptions, using fallbacks", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const toolContextLines: string[] = tools.map((toolName: string) => {
    const staticDescription: string | undefined = CRON_TOOL_DESCRIPTIONS[toolName];
    if (staticDescription) {
      return `  - ${toolName}: ${staticDescription}`;
    }

    if (toolName.startsWith("write_table_")) {
      const dynamicDescription: string | undefined = dynamicWriteToolDescriptions.get(toolName);
      if (dynamicDescription) {
        return `  - ${toolName}: ${dynamicDescription}`;
      }

      const tableName: string = toolName.replace(/^write_table_/, "");
      return `  - ${toolName}: Insert rows into the '${tableName}' table using validated column schemas.`;
    }

    if (toolName.startsWith("update_table_")) {
      const dynamicDescription: string | undefined = dynamicUpdateToolDescriptions.get(toolName);
      if (dynamicDescription) {
        return `  - ${toolName}: ${dynamicDescription}`;
      }

      const tableName: string = toolName.replace(/^update_table_/, "");
      return `  - ${toolName}: Update rows in the '${tableName}' table using validated column schemas.`;
    }

    return `  - ${toolName}: (no description available)`;
  });

  if (toolContextLines.length === 0) {
    return "The agent will have no tools available.";
  }

  return `The agent will have access to the following tools:\n${toolContextLines.join("\n")}`;
}
