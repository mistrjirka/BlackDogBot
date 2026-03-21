import { CRON_TOOL_DESCRIPTIONS } from "../shared/constants/cron-descriptions.js";
import { buildPerTableToolsAsync } from "./per-table-tools.js";

export async function buildCronToolContextBlockAsync(tools: string[]): Promise<string> {
  const dynamicWriteToolDescriptions: Map<string, string> = new Map();

  try {
    const perTableTools = await buildPerTableToolsAsync();
    for (const [toolName, toolDef] of Object.entries(perTableTools)) {
      if (typeof toolDef.description === "string" && toolDef.description.trim().length > 0) {
        dynamicWriteToolDescriptions.set(toolName, toolDef.description);
      }
    }
  } catch {
    // Ignore and fall back to generic write_table descriptions.
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

    return `  - ${toolName}: (no description available)`;
  });

  if (toolContextLines.length === 0) {
    return "The agent will have no tools available.";
  }

  return `The agent will have access to the following tools:\n${toolContextLines.join("\n")}`;
}
