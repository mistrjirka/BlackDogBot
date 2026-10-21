import { tool } from "ai";
import { z } from "zod";
import { VariableStore } from "../utils/variable-store.js";

const inspectVariableInputSchema = z.object({
  name: z.string().min(1).describe("Case-sensitive variable name shown in a stored-result stub (e.g. searxng_1)."),
  offset: z.number().int().nonnegative().default(0).describe("Character offset in the stored value, starting at 0."),
  maxChars: z.number().int().min(1).max(8000).default(2000).describe("Maximum characters to reveal (1–8000). Read only the segment you need."),
});

type InspectResult =
  | { name: string; offset: number; totalChars: number; nextOffset: number | null; content: string }
  | { error: "unknown_variable" | "no_active_store"; available: string[] };

/** Bounded, read-only inspection of a stored result. Does not export it to a shell. */
export function createInspectVariableTool(getStore: () => VariableStore | null) {
  return tool({
    description: "Inspect a bounded slice of an in-memory stored tool result. Use the exact variable name from a stub to read search evidence or other large results, then continue at nextOffset if needed. This does not execute code or read shell environment variables. Stored results exist only during the current agent run.",
    inputSchema: inspectVariableInputSchema,
    execute: async ({ name, offset, maxChars }: z.infer<typeof inspectVariableInputSchema>): Promise<InspectResult> => {
      const store = getStore();
      if (!store) {
        return { error: "no_active_store", available: [] };
      }
      if (!store.names().includes(name)) {
        return { error: "unknown_variable", available: store.names() };
      }
      const value = store.get(name);
      const text: string = typeof value === "string" ? value : JSON.stringify(value);
      const end = Math.min(offset + maxChars, text.length);
      return {
        name,
        offset,
        totalChars: text.length,
        nextOffset: end < text.length ? end : null,
        content: text.slice(offset, end),
      };
    },
    // VariableStore must not re-capture this intentionally bounded inspection;
    // toModelOutput also makes the slice directly readable by the model.
    toModelOutput: ({ output }: { output: InspectResult }) => ({ type: "text" as const, value: JSON.stringify(output) }),
  });
}
