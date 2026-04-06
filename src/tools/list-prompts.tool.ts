import { tool } from "langchain";
import { listPromptsToolInputSchema } from "../shared/schemas/tool-schemas.js";
import { PromptService, IPromptInfo } from "../services/prompt.service.js";

export const listPromptsTool = tool(
  async (): Promise<{ prompts: Array<{ name: string; path: string; isModified: boolean }> }> => {
    const promptService: PromptService = PromptService.getInstance();
    const prompts: IPromptInfo[] = await promptService.listPromptsAsync();

    const mappedPrompts: Array<{ name: string; path: string; isModified: boolean }> = prompts.map(
      (p: IPromptInfo) => ({
        name: p.name,
        path: p.path,
        isModified: p.isModified,
      }),
    );

    return { prompts: mappedPrompts };
  },
  {
    name: "list_prompts",
    description: "List all available prompt files and their modification status.",
    schema: listPromptsToolInputSchema,
  },
);
