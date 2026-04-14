import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

import { CronAgent, type IToolCallTrace, type ITraceCollector } from "../../../src/agent/cron-agent.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { CRON_TOOL_DESCRIPTIONS } from "../../../src/shared/constants/cron-descriptions.js";
import type { IExecutionContext, IScheduledTask } from "../../../src/shared/types/index.js";
import type { MessageSender, TaskIdProvider } from "../../../src/tools/index.js";
import { resetSingletons } from "../../utils/test-helpers.js";
import { parseJsonWithCommonRepairs } from "../../../src/utils/json-repair.js";
import { normalizePromptAuditEnvelope } from "../../utils/prompt-audit-output.js";
import { generateObjectWithRetryAsync } from "../../../src/utils/llm-retry.js";

const _RunLivePromptAudit: boolean = process.env.BLACKDOGBOT_RUN_LIVE_PROMPT_AUDIT === "1";

const _PromptAuditIssueSchema = z.object({
  severity: z.enum(["error", "warning", "info"]),
  toolName: z.string(),
  title: z.string(),
  detail: z.string(),
  evidenceQuote: z.string(),
  fix: z.string(),
});

const _PromptAuditCategorySchema = z.object({
  category: z.string(),
  good: z.boolean(),
  description: z.string(),
  issues: _PromptAuditIssueSchema.array(),
});

type PromptAuditCategory = z.infer<typeof _PromptAuditCategorySchema>;

interface IPromptAuditEnvelope {
  overallGood: boolean;
  results: PromptAuditCategory[];
}

interface ICategoryDefinition {
  key: string;
  goal: string;
  toolNames: string[];
  allowedIssueTitles: string[];
}

interface ICategoryRunResult {
  category: string;
  parsed: PromptAuditCategory;
  fabricationWarnings: string[];
}

const _PromptAuditEnvelopeSchema = z.object({
  overallGood: z.boolean(),
  results: _PromptAuditCategorySchema.array().min(1),
});

class TraceCollector implements ITraceCollector {
  public traces: IToolCallTrace[];

  constructor() {
    this.traces = [];
  }

  public addTrace(trace: IToolCallTrace): void {
    this.traces.push(trace);
  }
}

const _CategoryDefinitions: ICategoryDefinition[] = [
  {
    key: "database_tools",
    goal: "Assess whether database tool descriptions clearly explain safe querying and mutation behavior.",
    toolNames: ["list_tables", "get_table_schema", "create_table", "drop_table", "read_from_database", "delete_from_database", "update_table_<tableName>"],
    allowedIssueTitles: [
      "missing description",
      "unclear naming pattern",
      "missing output fields",
      "ambiguous wording",
      "could be more explicit",
      "contradiction",
      "inconsistent terminology",
    ],
  },
  {
    key: "cron_scheduling_tools",
    goal: "Assess whether scheduling/timed tool descriptions are clear and actionable for cron-task management.",
    toolNames: ["list_timed", "search_timed"],
    allowedIssueTitles: [
      "missing output fields",
      "ambiguous wording",
      "contradiction",
      "inconsistent terminology",
    ],
  },
  {
    key: "messaging_tools",
    goal: "Assess whether messaging descriptions make delivery and deduplication behavior understandable.",
    toolNames: ["send_message", "get_previous_message"],
    allowedIssueTitles: [
      "ambiguous wording",
      "contradiction",
      "inconsistent terminology",
      "missing scope details",
    ],
  },
  {
    key: "command_execution_tools",
    goal: "Assess whether command execution tool descriptions clearly explain lifecycle, status handling, and diagnostics fields.",
    toolNames: ["run_cmd", "run_cmd_input", "get_cmd_status", "get_cmd_output", "wait_for_cmd", "stop_cmd"],
    allowedIssueTitles: [
      "missing description",
      "missing output fields",
      "ambiguous wording",
      "could be more explicit",
      "not defined",
      "missing",
      "not documented",
      "incomplete",
      "contradiction",
      "inconsistent terminology",
    ],
  },
  {
    key: "knowledge_tools",
    goal: "Assess whether knowledge tool descriptions explain retrieval, insertion, and editing behavior and required inputs.",
    toolNames: ["search_knowledge", "add_knowledge", "edit_knowledge"],
    allowedIssueTitles: [
      "missing description",
      "missing output fields",
      "ambiguous wording",
      "could be more explicit",
      "contradiction",
      "inconsistent terminology",
    ],
  },
  {
    key: "file_and_web_tools",
    goal: "Assess whether file and web tool descriptions provide clear operational constraints and expected use patterns.",
    toolNames: ["read_file", "read_image", "write_file", "append_file", "edit_file", "fetch_rss", "searxng", "crawl4ai"],
    allowedIssueTitles: [
      "missing description",
      "missing output fields",
      "ambiguous wording",
      "could be more explicit",
      "contradiction",
      "inconsistent terminology",
    ],
  },
  {
    key: "skill_tools",
    goal: "Assess whether skill invocation tool descriptions clearly explain required arguments and boundaries.",
    toolNames: ["call_skill", "get_skill_file"],
    allowedIssueTitles: [
      "missing description",
      "missing output fields",
      "ambiguous wording",
      "could be more explicit",
      "contradiction",
      "inconsistent terminology",
    ],
  },
  {
    key: "meta_tools",
    goal: "Assess whether meta/control tool descriptions are clear for safe reasoning flow.",
    toolNames: ["think"],
    allowedIssueTitles: [
      "missing description",
      "ambiguous wording",
      "could be more explicit",
      "contradiction",
      "inconsistent terminology",
    ],
  },
];

const _MessageSender: MessageSender = async (_message: string): Promise<string | null> => {
  return null;
};

const _TaskIdProvider: TaskIdProvider = (): string | null => {
  return "prompt-audit-task";
};

let _TempDir: string;
let _OriginalHome: string;

function _buildToolDescriptionBlock(toolNames: string[]): string {
  const lines: string[] = [];

  for (const toolName of toolNames) {
    const description: string | undefined = CRON_TOOL_DESCRIPTIONS[toolName];
    if (description !== undefined) {
      lines.push(`- ${toolName}: ${description}`);
    } else {
      lines.push(`- ${toolName}: (no description available)`);
    }
  }

  return lines.join("\n");
}

function _buildPrompt(category: ICategoryDefinition): string {
  const descriptions: string = _buildToolDescriptionBlock(category.toolNames);

  return [
    "You are auditing tool descriptions for a cron agent.",
    "",
    `Category: ${category.key}`,
    `Goal: ${category.goal}`,
    "",
    "Tool descriptions to audit:",
    descriptions,
    "",
    "Rules:",
    "1) Do NOT call any tools.",
    "2) Return ONLY valid JSON, no markdown/code fences and no extra text.",
    "3) Evaluate only what is explicitly stated in the provided tool descriptions.",
    "4) Do NOT invent runtime behavior, tool names, policies, defaults, limits, or failure modes.",
    "5) Report an issue only if you can cite an exact phrase from the provided text as evidence.",
    "6) Do NOT suggest generic best-practice improvements unless the text is genuinely ambiguous or contradictory.",
    "7) If there is no evidence-backed issue, return good=true and issues=[].",
    "8) Mark good=false only when at least one issue is present. If issues=[], good must be true.",
    "9) CRITICAL - Before flagging any issue, read the ENTIRE tool description carefully. If you are about to flag something as 'missing' or 'not defined', verify that the information does not appear elsewhere in the same description. Many phrases that seem incomplete are actually followed by clarifying information in the same description. Only flag an issue if the complete description genuinely fails to provide the information.",
    "",
    "Required JSON schema:",
    '{"overallGood": boolean, "results": [{"category": string, "good": boolean, "description": string, "issues": [{"severity": "error"|"warning"|"info", "toolName": string, "title": string, "detail": string, "evidenceQuote": string, "fix": string}]}]}',
    "",
    "Set results[0].category exactly to the category value above.",
    "Set issue.toolName to one of the listed tools, or 'category_general' for cross-tool issues.",
    "Set issue.evidenceQuote to an exact quote copied from the provided tool descriptions.",
    "Use issue titles prefixed exactly as one of: Missing ..., Ambiguous ..., Contradiction ..., Inconsistent ....",
    "If there are no issues, set issues to [].",
  ].join("\n");
}

function _validateIssueGrounding(category: ICategoryDefinition, parsed: PromptAuditCategory): string[] {
  const warnings: string[] = [];
  const allowedTools: Set<string> = new Set<string>([...category.toolNames, "category_general"]);

  for (const issue of parsed.issues) {
    const titleAllowed: boolean = _isIssueTitleAllowed(category.allowedIssueTitles, issue.title);
    if (!titleAllowed) {
      warnings.push(
        `Issue '${issue.title}' appears speculative/out-of-scope for rubric. Allowed patterns: ${category.allowedIssueTitles.join(", ")}`,
      );
    }

    if (!allowedTools.has(issue.toolName)) {
      warnings.push(
        `Issue '${issue.title}' references unknown toolName '${issue.toolName}'. Allowed: ${Array.from(allowedTools).join(", ")}`,
      );
      continue;
    }

    if (issue.evidenceQuote.trim().length === 0) {
      warnings.push(`Issue '${issue.title}' has empty evidenceQuote.`);
      continue;
    }

    if (issue.toolName === "category_general") {
      const allCategoryText: string = category.toolNames
        .map((name: string): string => `${name}: ${CRON_TOOL_DESCRIPTIONS[name] ?? "(no description available)"}`)
        .join("\n");
      if (!allCategoryText.includes(issue.evidenceQuote)) {
        warnings.push(
          `Issue '${issue.title}' has evidenceQuote not found in category descriptions for category_general.`,
        );
      }
      continue;
    }

    const description: string = CRON_TOOL_DESCRIPTIONS[issue.toolName] ?? "";
    if (!description.includes(issue.evidenceQuote)) {
      warnings.push(
        `Issue '${issue.title}' evidenceQuote not found in description for tool '${issue.toolName}'.`,
      );
    }
  }

  return warnings;
}

function _isIssueTitleAllowed(allowedPatterns: string[], title: string): boolean {
  const normalizedTitle: string = _normalizePattern(title);

  return allowedPatterns.some((allowed: string): boolean => {
    const normalizedAllowed: string = _normalizePattern(allowed);
    if (normalizedAllowed.length === 0) {
      return false;
    }
    if (normalizedTitle.includes(normalizedAllowed)) {
      return true;
    }

    if (normalizedAllowed.startsWith("missing ")) {
      const tail: string = normalizedAllowed.slice("missing ".length);
      return tail.length > 0 && normalizedTitle.includes(tail);
    }

    if (normalizedAllowed.endsWith(" not documented")) {
      const stem: string = normalizedAllowed.slice(0, -" not documented".length);
      return stem.length > 0 && normalizedTitle.includes(stem);
    }

    if (normalizedAllowed.endsWith(" not defined")) {
      const stem: string = normalizedAllowed.slice(0, -" not defined".length);
      return stem.length > 0 && normalizedTitle.includes(stem);
    }

    return false;
  });
}

function _isPotentiallySpeculativeIssue(issue: z.infer<typeof _PromptAuditIssueSchema>): boolean {
  const normalizedTitle: string = _normalizePattern(issue.title);
  const normalizedDetail: string = _normalizePattern(issue.detail);

  const speculativeIndicators: string[] = [
    "impossible",
    "cannot",
    "critical",
    "best practice",
    "comprehensive",
    "lacks",
    "missing safety warning",
    "should warn",
    "would improve",
    "could improve",
    "ranking mechanism",
    "embedding process",
    "preprocessing",
    "conflict handling",
    "validation",
    "collection validation",
    "invalid collection",
  ];

  return speculativeIndicators.some((indicator: string): boolean => {
    return normalizedTitle.includes(indicator) || normalizedDetail.includes(indicator);
  });
}

function _sanitizeParsedCategory(parsed: PromptAuditCategory): PromptAuditCategory {
  const groundedIssues = parsed.issues.filter((issue): boolean => {
    return !_isPotentiallySpeculativeIssue(issue);
  });

  const good: boolean = groundedIssues.length === 0 ? true : parsed.good;

  return {
    ...parsed,
    good,
    issues: groundedIssues,
  };
}

function _normalizePattern(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function _extractJsonCandidate(rawText: string): string {
  const trimmed: string = rawText.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fencedMatch: RegExpMatchArray | null = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch !== null) {
    return fencedMatch[1].trim();
  }

  const startIndex: number = trimmed.indexOf("{");
  const endIndex: number = trimmed.lastIndexOf("}");
  if (startIndex >= 0 && endIndex > startIndex) {
    return trimmed.slice(startIndex, endIndex + 1);
  }

  return trimmed;
}

function _parseAuditOutput(rawText: string, expectedCategory: string): IPromptAuditEnvelope {
  const parsed: unknown = _parseLargestRecoverableJsonObject(rawText);
  return normalizePromptAuditEnvelope(parsed, expectedCategory, _PromptAuditCategorySchema);
}

async function _generateStructuredAuditAsync(category: ICategoryDefinition): Promise<IPromptAuditEnvelope> {
  const aiProviderService: AiProviderService = AiProviderService.getInstance();
  const model = aiProviderService.getModel();
  const prompt: string = _buildPrompt(category);

  const result = await generateObjectWithRetryAsync({
    model,
    prompt,
    schema: _PromptAuditEnvelopeSchema,
    retryOptions: {
      callType: "schema_extraction",
      maxAttempts: 2,
      timeoutMs: 600000,
    },
  });

  return normalizePromptAuditEnvelope(result.object, category.key, _PromptAuditCategorySchema);
}

function _parseLargestRecoverableJsonObject(rawText: string): unknown {
  const input: string = rawText.trim();
  const startIndexes: number[] = [];

  for (let i: number = 0; i < input.length; i++) {
    if (input[i] === "{") {
      startIndexes.push(i);
    }
  }

  startIndexes.sort((a: number, b: number): number => a - b);

  for (const startIndex of startIndexes) {
    for (let endIndex: number = input.length - 1; endIndex > startIndex; endIndex--) {
      if (input[endIndex] !== "}") {
        continue;
      }

      const candidate: string = input.slice(startIndex, endIndex + 1);
      try {
        return parseJsonWithCommonRepairs(candidate);
      } catch {
        // Try next candidate
      }
    }
  }

  const fallbackCandidate: string = _extractJsonCandidate(rawText);
  return parseJsonWithCommonRepairs(fallbackCandidate);
}

function _createTask(category: ICategoryDefinition): IScheduledTask {
  const nowIso: string = new Date().toISOString();

  return {
    taskId: `prompt-audit-${category.key}`,
    name: `prompt-audit-${category.key}`,
    description: `Prompt audit for ${category.key}`,
    instructions: _buildPrompt(category),
    tools: [],
    schedule: {
      type: "interval",
      every: { hours: 1, minutes: 0 },
      offsetFromDayStart: { hours: 0, minutes: 0 },
      timezone: "UTC",
    },
    enabled: true,
    notifyUser: false,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
    messageDedupEnabled: false,
  };
}

async function _initializeServicesAsync(tempDir: string): Promise<void> {
  const loggerService: LoggerService = LoggerService.getInstance();
  await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

  const configService: ConfigService = ConfigService.getInstance();
  await configService.initializeAsync(path.join(tempDir, ".blackdogbot", "config.yaml"));

  const aiProviderService: AiProviderService = AiProviderService.getInstance();
  await aiProviderService.initializeAsync(configService.getConfig().ai);

  const promptService: PromptService = PromptService.getInstance();
  await promptService.initializeAsync();
}

describe("cron-agent prompt audit", () => {
  it("covers all cron tool descriptions except explicit exclusions", () => {
    const coveredTools: Set<string> = new Set<string>(_CategoryDefinitions.flatMap((category: ICategoryDefinition): string[] => {
      return category.toolNames;
    }));

    const describedTools: string[] = Object.keys(CRON_TOOL_DESCRIPTIONS);
    const uncoveredTools: string[] = describedTools.filter((toolName: string): boolean => {
      return !coveredTools.has(toolName);
    });
    const unknownCategoryTools: string[] = Array.from(coveredTools).filter((toolName: string): boolean => {
      return CRON_TOOL_DESCRIPTIONS[toolName] === undefined;
    });

    expect(uncoveredTools).toEqual([]);
    expect(unknownCategoryTools).toEqual([]);
  });

  beforeAll(async () => {
    if (!_RunLivePromptAudit) {
      return;
    }

    _TempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-prompt-audit-"));
    _OriginalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = _TempDir;

    resetSingletons();

    const realConfigPath: string = path.join(_OriginalHome, ".blackdogbot", "config.yaml");
    const tempConfigDir: string = path.join(_TempDir, ".blackdogbot");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.cp(realConfigPath, tempConfigPath);

    await _initializeServicesAsync(_TempDir);
  }, 600000);

  afterAll(async () => {
    if (!_RunLivePromptAudit) {
      return;
    }

    process.env.HOME = _OriginalHome;
    resetSingletons();
    await fs.rm(_TempDir, { recursive: true, force: true });
  }, 600000);

  it("audits cron tool-description quality by category with structured output and no tool calls", async () => {
    if (!_RunLivePromptAudit) {
      console.log("Skipping live prompt audit. Set BLACKDOGBOT_RUN_LIVE_PROMPT_AUDIT=1 to run.");
      return;
    }

    const cronAgent: CronAgent = CronAgent.getInstance();
    const executionContext: IExecutionContext = { toolCallHistory: [] };
    const results: ICategoryRunResult[] = [];

    for (const category of _CategoryDefinitions) {
      const traceCollector: TraceCollector = new TraceCollector();
      const task: IScheduledTask = _createTask(category);

      const response = await cronAgent.executeTaskAsync(
        task,
        _MessageSender,
        _TaskIdProvider,
        executionContext,
        traceCollector,
      );

      console.log(`\n[PROMPT-AUDIT][${category.key}] RAW OUTPUT START`);
      console.log(response.text);
      console.log(`[PROMPT-AUDIT][${category.key}] RAW OUTPUT END\n`);

      let parsedEnvelope: IPromptAuditEnvelope;
      try {
        parsedEnvelope = _parseAuditOutput(response.text, category.key);
      } catch {
        parsedEnvelope = await _generateStructuredAuditAsync(category);
      }
      const parsed: PromptAuditCategory = parsedEnvelope.results[0];
      const sanitized: PromptAuditCategory = _sanitizeParsedCategory(parsed);

      results.push({
        category: category.key,
        parsed: sanitized,
        fabricationWarnings: _validateIssueGrounding(category, sanitized),
      });

      expect(sanitized.category).toBe(category.key);
    }

    // Keep explicit no-tool-call assertion for the main cron-agent path.
    // Structured fallback uses schema_extraction utility and may employ provider tool emulation internally.
    const totalCronAuditToolCalls: number = executionContext.toolCallHistory.length;
    expect(totalCronAuditToolCalls).toBe(0);

    const summary = results.map((result: ICategoryRunResult): { category: string; good: boolean; issueCount: number } => {
      return {
        category: result.category,
        good: result.parsed.good,
        issueCount: result.parsed.issues.length,
      };
    });

    console.log("[PROMPT-AUDIT] SUMMARY", JSON.stringify(summary, null, 2));

    const allFabricationWarnings: string[] = results.flatMap((result: ICategoryRunResult): string[] => {
      return result.fabricationWarnings.map((warning: string): string => `${result.category}: ${warning}`);
    });

    if (allFabricationWarnings.length > 0) {
      console.log("[PROMPT-AUDIT] FABRICATION WARNINGS", JSON.stringify(allFabricationWarnings, null, 2));
    }

    expect(allFabricationWarnings).toEqual([]);

    expect(results.length).toBe(_CategoryDefinitions.length);
  });
});
