import { tool } from "langchain";
import { modifyPromptToolInputSchema, EDITABLE_PROMPT_NAMES } from "../shared/schemas/tool-schemas.js";
import { PromptService } from "../services/prompt.service.js";

const _EditablePromptSet: ReadonlySet<string> = new Set(EDITABLE_PROMPT_NAMES);

export const modifyPromptTool = tool(
  async ({ promptName, action, content }: { promptName: string; action: "read" | "write" | "append"; content?: string }): Promise<{ success: boolean; content: string | undefined; message: string }> => {
    if (!_EditablePromptSet.has(promptName)) {
      return {
        success: false,
        content: undefined,
        message: `Invalid prompt name "${promptName}". Valid names: ${EDITABLE_PROMPT_NAMES.join(", ")}`,
      };
    }

    const promptService: PromptService = PromptService.getInstance();

    try {
      switch (action) {
        case "read": {
          const fileContent: string = await promptService.getPromptRawAsync(promptName);

          return { success: true, content: fileContent, message: "Prompt read successfully." };
        }
        case "write": {
          if (!content) {
            return { success: false, content: undefined, message: "Content is required for write action." };
          }

          await promptService.writePromptAsync(promptName, content);

          return { success: true, content: undefined, message: "Prompt written successfully." };
        }
        case "append": {
          if (!content) {
            return { success: false, content: undefined, message: "Content is required for append action." };
          }

          await promptService.appendToPromptAsync(promptName, content);

          return { success: true, content: undefined, message: "Content appended successfully." };
        }
      }
    } catch (error: unknown) {
      return { success: false, content: undefined, message: (error as Error).message };
    }
  },
  {
    name: "modify_prompt",
    description: "Read, write, or append to a prompt file. Use prompt names without .md extension (e.g. 'main-agent', 'prompt-fragments/xml-tag-guide').",
    schema: modifyPromptToolInputSchema,
  },
);
