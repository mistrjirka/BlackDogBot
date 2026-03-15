import { describe, expect, it } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";

import { addLitesqlNodeToolInputSchema } from "../../src/shared/schemas/tool-schemas.js";
import { wrapToolSetWithReasoning } from "../../src/utils/tool-reasoning-wrapper.js";
import { tool, type ToolSet } from "ai";

describe("tool schema emission", () => {
  it("emits object-root JSON schema for add_litesql_node with reasoning wrapper", () => {
    const tools: ToolSet = {
      add_litesql_node: tool({
        inputSchema: addLitesqlNodeToolInputSchema,
      }),
    };

    const wrapped: ToolSet = wrapToolSetWithReasoning(tools);
    const schema = zodToJsonSchema(wrapped.add_litesql_node.inputSchema as never) as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;

    expect(schema.type).toBe("object");
    expect(properties).toBeDefined();
    expect(properties.inputSchemaHint).toBeDefined();
    expect(properties.reasoning).toBeDefined();
  });
});
