# Phase 2: Tool Type Incompatibility Notes

## The Problem

When migrating tools from Vercel AI SDK (`ai` package) to LangChain (`langchain` package), we discovered a **fundamental type incompatibility** between the two SDKs.

### Vercel AI SDK Tool Type

```typescript
// From 'ai' package
import { Tool, ToolSet } from "ai";

interface Tool<TInput, TResult> {
  description?: string;
  inputSchema: FlexibleSchema<TInput>;  // <-- Different property name
  execute?: (input: TInput, options: ToolExecutionOptions) => Promise<TResult>;
  onInputAvailable?: (options: ToolExecutionOptions) => void | Promise<void>;
  onInputStart?: (options: ToolExecutionOptions) => void | Promise<void>;
  onInputDelta?: (options: ToolExecutionOptions) => void | Promise<void>;
  needsApproval?: boolean;
}

type ToolSet = Record<string, Tool<any, any>>;
```

### LangChain DynamicStructuredTool Type

```typescript
// From '@langchain/core/tools'
import { DynamicStructuredTool } from "@langchain/core/tools";

class DynamicStructuredTool<RunInput, CallInput, Output, CallOptions, Name extends string> {
  name: Name;
  description: string;
  schema: ZodType<CallInput>;  // <-- Different property name AND type
  func: (input: CallInput, runManager?: CallbackManagerForToolRun) => Promise<Output>;
}
```

### Key Differences

| Aspect | Vercel AI (`Tool`) | LangChain (`DynamicStructuredTool`) |
|--------|-------------------|-----------------------------------|
| Schema property | `inputSchema` | `schema` |
| Schema type | `FlexibleSchema` (internal Vercel type) | `ZodType` (standard Zod) |
| Execute function | `execute(input, options)` | `func(input, runManager?)` |
| Type params | `<TInput, TResult>` | `<RunInput, CallInput, Output, CallOptions, Name>` |
| Streaming | `onInputStart/Delta/Available` | Uses callbacks via `runManager` |

## The Solution

### Temporary: Use `as unknown as Tool` Casts (Phase 2-4)

During the migration, Vercel AI agents (`ToolLoopAgent`, `BaseAgentBase`) still need Vercel AI `Tool` types. But all our tools are now LangChain `DynamicStructuredTool`.

**The runtime behavior works** because:
1. Both SDKs use Zod schemas under the hood
2. The execute/func signatures are effectively the same (async function taking input)
3. The tool calling flow doesn't depend on the type-level differences

**The TypeScript error is real** because the types are incompatible at compile time.

```typescript
// Temporary cast pattern (Phase 2-4 only)
import { Tool } from "ai";
import { myTool } from "./my-tool.tool.js";  // DynamicStructuredTool

const tools: Record<string, Tool> = {
  my_tool: myTool as unknown as Tool,  // Required!
};
```

### Permanent: Remove Casts in Phase 5

When we delete Vercel AI agents and replace with DeepAgents, all casts become unnecessary:

```typescript
// Phase 5: DeepAgents uses LangChain tools natively
import { createDeepAgent } from "deepagents";
import { myTool } from "./my-tool.tool.js";  // DynamicStructuredTool

const agent = createDeepAgent({
  model,
  tools: [myTool],  // No cast needed! DeepAgents accepts DynamicStructuredTool
  systemPrompt: "...",
});
```

## Package Collision Warning

### The Import Conflict

Both packages export overlapping types:
- `ai` exports: `Tool`, `ToolSet`, `LanguageModel`, `ToolLoopAgent`, `stepCountIs`
- `langchain` exports: `Tool` (different!), `tool` function
- `@langchain/core/tools` exports: `DynamicStructuredTool`, `StructuredTool`

### Best Practices

1. **Explicit type imports**:
   ```typescript
   // Bad: ambiguous
   import { Tool } from "ai";
   
   // Good: explicit
   import type { Tool } from "ai";
   import type { DynamicStructuredTool } from "@langchain/core/tools";
   ```

2. **Never import from both in the same file** (unless necessary):
   ```typescript
   // Avoid this pattern when possible
   import { tool } from "langchain";
   import { ToolLoopAgent, Tool } from "ai";  // Different Tool type!
   ```

3. **Use utility adapter file** (temporary):
   ```typescript
   // src/utils/langchain-tool-adapter.ts
   import type { Tool } from "ai";
   import type { DynamicStructuredTool } from "@langchain/core/tools";
   
   export function asVercelTool(tool: DynamicStructuredTool): Tool {
     return tool as unknown as Tool;
   }
   ```

## Files Requiring Temporary Casts

### Agent Files (until Phase 5)

| File | Location | Cast Type |
|------|----------|-----------|
| `src/agent/main-agent.ts` | `tools` object assignments | `as unknown as Tool` |
| `src/agent/cron-agent.ts` | `availableTools` object assignments | `as unknown as Tool` |
| `src/skills/setup-runner.ts` | `tools` passed to `ToolLoopAgent` | `as unknown as Tool` |
| `src/tools/call-skill.tool.ts` | `tools` passed to `ToolLoopAgent` | `as unknown as Tool` |

### Tool Wrapper Functions

| File | Function | Adjustment |
|------|----------|------------|
| `src/agent/cron-agent.ts` | `_wrapCronCreateTableTool` | Return type `Tool`, input type `Tool` |
| `src/agent/main-agent.ts` | `_wrapCreateTableWithHotReload` | Return type `Tool`, input type `Tool` |

### Removed Features (no cast needed)

These tools no longer use `ToolExecuteContext` (LangChain doesn't have this concept):

| File | Change |
|------|--------|
| `src/tools/get-cron.tool.ts` | Removed `_context: ToolExecuteContext` parameter |
| `src/tools/edit-cron.tool.ts` | Removed `createToolWithPrerequisites` wrapper |
| `src/tools/edit-cron-instructions.tool.ts` | Removed `createToolWithPrerequisites` wrapper |

**Note**: The prerequisite checking feature (`createToolWithPrerequisites`) needs to be re-implemented for DeepAgents in Phase 6 or later.

## Verification

After Phase 5 (when Vercel AI SDK is removed), this command should return no results:

```bash
# Check for remaining temp casts
rg "as unknown as Tool" src/ --include "*.ts"

# Check for remaining Vercel AI Tool imports
rg "from ['\"]ai['\"]" src/ --include "*.ts" | grep -v "// Phase"
```

## See Also

- `MIGRATION_PLAN.md` — Full migration timeline
- `src/utils/langchain-tool-adapter.ts` — Temporary adapter functions
- DeepAgents docs: https://docs.langchain.com/oss/javascript/deepagents/