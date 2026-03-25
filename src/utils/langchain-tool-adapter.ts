/**
 * Temporary adapter for LangChain tools during migration from Vercel AI SDK to DeepAgents.
 *
 * MIGRATION CONTEXT:
 * - Phase 2: Tools are converted to LangChain's DynamicStructuredTool format
 * - Phase 5: Vercel AI agents will be replaced with DeepAgents
 * - Until Phase 5, we need to pass LangChain tools to Vercel AI agents
 * - Vercel AI's Tool type has `inputSchema` while LangChain's has `schema`
 * - These types are incompatible, so we use `as unknown as Tool` cast
 *
 * AFTER PHASE 5:
 * - This file should be deleted
 * - All `asVercelTool()` casts should be removed
 * - DeepAgents accepts LangChain tools directly
 */

import type { Tool } from "ai";
import type { DynamicStructuredTool } from "@langchain/core/tools";

/**
 * Cast a LangChain DynamicStructuredTool to Vercel AI SDK's Tool type.
 *
 * IMPORTANT: This is a temporary workaround during Phase 2-4 of the migration.
 * The cast is necessary because Vercel AI's Tool and LangChain's DynamicStructuredTool
 * have incompatible type signatures:
 * - Vercel AI: Tool has `inputSchema: FlexibleSchema`
 * - LangChain: DynamicStructuredTool has `schema: ZodType`
 *
 * At runtime, both work similarly enough for Vercel AI agents to use them.
 * The schema is used for input validation and tool calling.
 *
 * @param tool - A LangChain DynamicStructuredTool
 * @returns The tool cast as Vercel AI Tool type (unsafe but works at runtime)
 */
export function asVercelTool(tool: DynamicStructuredTool): Tool {
  return tool as unknown as Tool;
}

/**
 * Cast a Record of LangChain tools to Vercel AI SDK's ToolSet type.
 *
 * @param tools - A record of tool name to DynamicStructuredTool
 * @returns The record cast as Vercel AI ToolSet type
 */
export function asVercelToolSet(tools: Record<string, DynamicStructuredTool>): Record<string, Tool> {
  return tools as unknown as Record<string, Tool>;
}