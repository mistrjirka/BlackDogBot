import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { INCLUDE_DIRECTIVE_REGEX } from "../../../src/shared/constants.js";
import { createBaseToolSet } from "../../../src/agent/tool-assembly.js";
import { FileReadTracker, type MessageSender } from "../../../src/tools/index.js";

/**
 * Contract lint: the main-agent prompt must not advertise tools that the chat
 * agent does not register. Regression for the create_table drift where the
 * prompt directed "call create_table first" while the tool only existed in
 * the cron agent, so three different models "correctly" reported a missing
 * tool.
 */

//#region Helpers

const _thisDir: string = path.dirname(fileURLToPath(import.meta.url));
const _PROMPTS_DIR: string = path.resolve(_thisDir, "..", "..", "..", "src", "defaults", "prompts");

const mockMessageSender: MessageSender = async (_message: string): Promise<string | null> => null;
const mockFileSender = async (): Promise<string | null> => null;

/**
 * Backtick-quoted tokens that look like tool names (snake_case with at least
 * one underscore) but are not tools: status values, column names and example
 * table names.
 */
const _NON_TOOL_TOKENS: ReadonlySet<string> = new Set([
  "awaiting_input",
  "created_at",
  "updated_at",
  "news_items",
]);

/**
 * Static chat tool names added by assembleToolsForChat on top of
 * createBaseToolSet. Keep in sync with src/agent/tool-assembly.ts.
 */
const _CHAT_STATIC_EXTRA_TOOLS: string[] = [
  "read_image",
  "list_skills",
  "load_skill",
  "get_skill_file",
  "delegate_agent",
  "create_table",
  "inspect_variable",
];

async function _resolveIncludesAsync(content: string, depth: number): Promise<string> {
  if (depth > 5) {
    throw new Error("Prompt include nesting too deep");
  }

  const matches: RegExpStringIterator<RegExpExecArray> = content.matchAll(INCLUDE_DIRECTIVE_REGEX);
  let result: string = "";
  let lastIndex: number = 0;

  for (const match of matches) {
    const fullMatch: string = match[0];
    const filename: string = match[1].trim();
    const matchIndex: number = match.index ?? 0;

    result += content.slice(lastIndex, matchIndex);

    const includePath: string = path.join(_PROMPTS_DIR, filename);
    const includeContent: string = await fs.readFile(includePath, "utf-8");
    result += await _resolveIncludesAsync(includeContent, depth + 1);
    lastIndex = matchIndex + fullMatch.length;
  }

  result += content.slice(lastIndex);
  return result;
}

async function _loadMainAgentPromptAsync(): Promise<string> {
  const content: string = await fs.readFile(path.join(_PROMPTS_DIR, "main-agent.md"), "utf-8");
  return _resolveIncludesAsync(content, 0);
}

function _extractSnakeCaseBacktickTokens(prompt: string): Set<string> {
  const tokens: Set<string> = new Set();
  const backtickRe = /`([^`\n]+)`/g;

  for (const match of prompt.matchAll(backtickRe)) {
    const token: string = match[1].trim();
    if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(token)) {
      tokens.add(token);
    }
  }

  return tokens;
}

function _chatStaticToolNames(): Set<string> {
  const baseTools = createBaseToolSet(mockMessageSender, new FileReadTracker(), mockFileSender);
  return new Set<string>([...Object.keys(baseTools), ..._CHAT_STATIC_EXTRA_TOOLS]);
}

//#endregion Helpers

describe("main-agent prompt tool contract", () => {
  it("every advertised snake_case tool-like token is a real chat tool", async () => {
    const prompt: string = await _loadMainAgentPromptAsync();
    const tokens: Set<string> = _extractSnakeCaseBacktickTokens(prompt);

    // Sanity: the extractor must actually find tool names in the prompt.
    expect(tokens.size).toBeGreaterThan(0);
    expect(tokens.has("create_table")).toBe(true);

    const expected: Set<string> = _chatStaticToolNames();

    const violations: string[] = [...tokens].filter(
      (token: string): boolean =>
        !expected.has(token) &&
        !token.startsWith("write_table_") &&
        !token.startsWith("update_table_") &&
        !_NON_TOOL_TOKENS.has(token),
    );

    expect(violations).toEqual([]);
  });

  it("create_table is advertised in the prompt AND registered for chat (regression: §4.3 drift)", async () => {
    const prompt: string = await _loadMainAgentPromptAsync();

    expect(prompt).toContain("create_table");
    expect(_chatStaticToolNames().has("create_table")).toBe(true);
  });

  it("teaches the variable reference shape (blackboard Phase 1)", async () => {
    const prompt: string = await _loadMainAgentPromptAsync();

    // Guards the "use {\"type\":\"variable\",\"name\":...}" teaching against deletion.
    expect(prompt).toContain("\"type\":\"variable\"");
    // Stored-variables section marker + every variable-capable sink named.
    expect(prompt).toContain("Stored variables");
    expect(prompt).toContain("write_table_<name>");
    expect(prompt).toContain("write_file");
    expect(prompt).toContain("add_knowledge");
    expect(prompt).toContain("Use `inspect_variable`");
    expect(prompt).toContain("not shell environment variables");
    expect(prompt).toContain("run_cmd` accepts a literal shell command");
    const runCmd = createBaseToolSet(mockMessageSender, new FileReadTracker()).run_cmd;
    expect(runCmd?.description).toContain("cannot access BlackDogBot's per-run blackboard variables");
    // Stub `meta` token teaching (FIX-1 wrapper extras) — plain backticked word, no
    // snake_case underscores, so the token-lint extractor ignores it by construction.
    expect(prompt).toContain("`meta`");
  });
});
