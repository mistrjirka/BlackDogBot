import { tool } from "ai";
import { z } from "zod";
import {
  INSPECT_VARIABLE_DEFAULT_CHARS,
  INSPECT_VARIABLE_MAX_CHARS,
  formatCharLimit,
} from "../shared/limits.js";
import { VariableStore } from "../utils/variable-store.js";

const inspectVariableInputSchema = z.object({
  name: z.string().min(1).optional().describe("Exact stored name. Omit to list available saved variables with sizes, not their values."),
  offset: z.number().int().nonnegative().default(0).describe("Character offset in the stored value, starting at 0."),
  maxChars: z.number()
    .int()
    .min(1)
    .max(INSPECT_VARIABLE_MAX_CHARS)
    .default(INSPECT_VARIABLE_DEFAULT_CHARS)
    .describe(
      `Maximum characters to reveal (1–${formatCharLimit(INSPECT_VARIABLE_MAX_CHARS)}; ` +
      `default ${formatCharLimit(INSPECT_VARIABLE_DEFAULT_CHARS)}). Read only the segment you need.`,
    ),
});

type InspectResult =
  | { name: string; offset: number; totalChars: number; nextOffset: number | null; content: string }
  | { error: "unknown_variable" | "no_active_store"; available: string[] }
  | { variables: ReturnType<VariableStore["inventory"]>; count: number };

/** Bounded, read-only inspection of a stored result. Does not export it to a shell. */
export function createInspectVariableTool(getStore: () => VariableStore | null) {
  return tool({
    description: "List saved chat variables (omit name), or inspect a bounded slice of one. Variables survive user turns and restart, subject to FIFO retention. Use run_code to filter large results instead of paging through them. No shell environment access.",
    inputSchema: inspectVariableInputSchema,
    execute: async ({ name, offset, maxChars }: z.infer<typeof inspectVariableInputSchema>): Promise<InspectResult> => {
      const store = getStore();
      if (!store) {
        return { error: "no_active_store", available: [] };
      }
      if (name === undefined) {
        const variables = store.inventory();
        return { variables, count: variables.length };
      }
      if (!store.names().includes(name)) {
        return { error: "unknown_variable", available: store.names() };
      }
      const value = store.get(name);
      const text: string = typeof value === "string" ? value : JSON.stringify(value);
      const safeOffset: number = Math.min(Math.max(0, offset), text.length);
      const end = Math.min(safeOffset + maxChars, text.length);
      return {
        name,
        offset: safeOffset,
        totalChars: text.length,
        nextOffset: end < text.length ? end : null,
        content: text.slice(safeOffset, end),
      };
    },
    // VariableStore must not re-capture this intentionally bounded inspection;
    // toModelOutput also makes the slice directly readable by the model.
    toModelOutput: ({ output }: { output: InspectResult }) => {
      if ("error" in output || "variables" in output) {
        return { type: "text" as const, value: JSON.stringify(output) };
      }

      const end: number = output.offset + output.content.length;
      return {
        type: "text" as const,
        value:
          `[variable ${output.name}; chars ${output.offset}-${end}/${output.totalChars}; ` +
          `nextOffset: ${output.nextOffset ?? "none"}]
${output.content}`,
      };
    },
  });
}
