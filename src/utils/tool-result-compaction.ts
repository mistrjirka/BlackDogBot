import { LoggerService } from "../services/logger.service.js";
import { generateTextWithRetryAsync } from "./llm-retry.js";
import { AiProviderService } from "../services/ai-provider.service.js";
import type { LanguageModel } from "ai";

//#region Constants

/**
 * Default maximum tokens for a tool result before it gets compacted.
 */
const DEFAULT_MAX_TOOL_RESULT_TOKENS: number = 2_000;

/**
 * Number of representative array items to keep when compacting arrays.
 */
const DEFAULT_REPRESENTATIVE_ARRAY_SIZE: number = 5;

/**
 * Maximum number of fields to summarize in a single pass.
 */
const MAX_SUMMARIZED_FIELDS_PER_PASS: number = 10;

/**
 * Marker to indicate a field has been summarized to avoid re-summarization.
 */
const COMPACTION_SUMMARY_MARKER: string = "[COMPACTION_SUMMARY]";

/**
 * Prefix for companion summary fields added for arrays.
 */
const ARRAY_SUMMARY_FIELD_SUFFIX: string = "_summary";

/**
 * Prefix for companion field storing original array length.
 */
const ARRAY_ORIGINAL_COUNT_FIELD_SUFFIX: string = "_originalCount";

//#endregion Constants

//#region Interfaces

export interface ICompactionOptions {
  /** Maximum tokens before a result is considered oversized. */
  maxTokens?: number;
  /** Number of representative array items to keep. */
  representativeArraySize?: number;
  /** Logger for debugging. */
  logger?: LoggerService;
}

export interface ICompactionResult {
  /** The compacted result preserving original shape. */
  value: unknown;
  /** Whether compaction was applied. */
  wasCompacted: boolean;
  /** Number of fields that were summarized. */
  summarizedFields: number;
  /** Original token count estimate. */
  originalTokens: number;
  /** Token count estimate after compaction. */
  compactedTokens: number;
}

//#endregion Interfaces

//#region Public Functions

/**
 * Compacts an oversized tool result while preserving its top-level shape.
 * 
 * This function:
 * - Preserves the original object structure and keys
 * - Summarizes oversized string fields
 * - Keeps representative items for large arrays + adds summary metadata
 * - Marks already-summarized fields to avoid re-summarization
 * - Preserves identity fields (id, url, name, status, timestamps) when small
 */
export async function compactToolResultAsync(
  value: unknown,
  options: ICompactionOptions = {},
): Promise<ICompactionResult> {
  const maxTokens: number = options.maxTokens ?? DEFAULT_MAX_TOOL_RESULT_TOKENS;
  const representativeArraySize: number = options.representativeArraySize ?? DEFAULT_REPRESENTATIVE_ARRAY_SIZE;
  const logger: LoggerService = options.logger ?? LoggerService.getInstance();

  const originalTokens: number = estimateTokenCount(value);
  if (originalTokens <= maxTokens) {
    return {
      value,
      wasCompacted: false,
      summarizedFields: 0,
      originalTokens,
      compactedTokens: originalTokens,
    };
  }

  logger.info("Tool result compaction triggered", {
    originalTokens,
    maxTokens,
    valueType: typeof value,
    isArray: Array.isArray(value),
  });

  const context = new CompactionContext(representativeArraySize, logger);
  const compactedValue = await compactValueRecursive(value, maxTokens, context);

  const compactedTokens: number = estimateTokenCount(compactedValue);
  logger.info("Tool result compaction complete", {
    originalTokens,
    compactedTokens,
    reduction: originalTokens - compactedTokens,
    summarizedFields: context.summarizedFields,
  });

  return {
    value: compactedValue,
    wasCompacted: true,
    summarizedFields: context.summarizedFields,
    originalTokens,
    compactedTokens,
  };
}

/**
 * Estimates the token count for a given value using character-based approximation.
 */
export function estimateTokenCount(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }

  const str: string = typeof value === "string" ? value : JSON.stringify(value);
  // Approximate 4 characters per token
  return Math.ceil(str.length / 4);
}

//#endregion Public Functions

//#region Private Classes

class CompactionContext {
  public summarizedFields: number = 0;

  constructor(
    public readonly representativeArraySize: number,
    public readonly logger: LoggerService,
  ) {}

  public incrementSummarized(): void {
    this.summarizedFields++;
  }
}

//#endregion Private Classes

//#region Private Functions

/**
 * Recursively compact a value while preserving shape.
 */
async function compactValueRecursive(
  value: unknown,
  maxTokens: number,
  context: CompactionContext,
): Promise<unknown> {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return compactStringField(value, maxTokens, context);
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return compactArrayField(value, maxTokens, context);
  }

  // It's an object - compact its fields
  return compactObjectField(value as Record<string, unknown>, maxTokens, context);
}

/**
 * Compact a string field if it's oversized.
 */
async function compactStringField(
  value: string,
  maxTokens: number,
  context: CompactionContext,
): Promise<string> {
  // Already summarized?
  if (value.includes(COMPACTION_SUMMARY_MARKER)) {
    return value;
  }

  const tokens = estimateTokenCount(value);
  if (tokens <= maxTokens) {
    return value;
  }

  // Summarize the string
  const summary = await summarizeText(value, maxTokens, context.logger);
  context.incrementSummarized();
  return `${COMPACTION_SUMMARY_MARKER} ${summary}`;
}

/**
 * Compact an array field, keeping representative items and adding summary metadata.
 */
async function compactArrayField(
  value: unknown[],
  maxTokens: number,
  context: CompactionContext,
): Promise<unknown[]> {
  if (value.length === 0) {
    return value;
  }

  // Check if the whole array needs compaction
  const arrayTokens = estimateTokenCount(value);
  if (arrayTokens <= maxTokens) {
    return value;
  }

  // Keep representative items
  const representativeItems = value.slice(0, context.representativeArraySize);
  
  // Compact each representative item if needed
  const compactedItems: unknown[] = [];
  for (const item of representativeItems) {
    const compactedItem = await compactValueRecursive(item, maxTokens / context.representativeArraySize, context);
    compactedItems.push(compactedItem);
  }

  context.incrementSummarized();
  return compactedItems;
}

/**
 * Compact an object field by recursively processing its properties.
 */
async function compactObjectField(
  value: Record<string, unknown>,
  maxTokens: number,
  context: CompactionContext,
): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  let fieldsSummarizedInThisPass = 0;

  // First pass: compact oversized fields
  for (const [key, fieldValue] of Object.entries(value)) {
    // Skip companion summary fields (already processed)
    if (key.endsWith(ARRAY_SUMMARY_FIELD_SUFFIX) || key.endsWith(ARRAY_ORIGINAL_COUNT_FIELD_SUFFIX)) {
      result[key] = fieldValue;
      continue;
    }

    // Check if this is an array with companion summary fields
    if (Array.isArray(fieldValue) && `${key}${ARRAY_SUMMARY_FIELD_SUFFIX}` in value) {
      // This array already has summary metadata, keep it as-is
      result[key] = fieldValue;
      continue;
    }

    // Estimate tokens for this field
    const fieldTokens = estimateTokenCount(fieldValue);
    
    // Identity fields and small fields are preserved
    if (isIdentityField(key) || fieldTokens <= maxTokens / 10) {
      result[key] = fieldValue;
      continue;
    }

    // Check if we've summarized too many fields in this pass
    if (fieldsSummarizedInThisPass >= MAX_SUMMARIZED_FIELDS_PER_PASS) {
      result[key] = fieldValue;
      continue;
    }

    // Compact this field
    const compactedValue = await compactValueRecursive(fieldValue, maxTokens / 10, context);
    result[key] = compactedValue;
    fieldsSummarizedInThisPass++;

    // If it's an array, add companion summary fields
    if (Array.isArray(fieldValue) && fieldValue.length > context.representativeArraySize) {
      const arraySummary = await summarizeArray(fieldValue, context.logger);
      result[`${key}${ARRAY_SUMMARY_FIELD_SUFFIX}`] = `${COMPACTION_SUMMARY_MARKER} ${arraySummary}`;
      result[`${key}${ARRAY_ORIGINAL_COUNT_FIELD_SUFFIX}`] = fieldValue.length;
    }
  }

  return result;
}

/**
 * Check if a field name suggests it's an identity field that should be preserved.
 */
function isIdentityField(key: string): boolean {
  const lowerKey = key.toLowerCase();
  const identityPatterns = [
    "id",
    "url",
    "uri",
    "name",
    "status",
    "type",
    "timestamp",
    "date",
    "time",
    "created",
    "updated",
    "modified",
    "error",
    "success",
    "code",
  ];

  return identityPatterns.some(pattern => lowerKey.includes(pattern));
}

/**
 * Summarize text using the LLM.
 */
async function summarizeText(
  text: string,
  maxTokens: number,
  logger: LoggerService,
): Promise<string> {
  try {
    const model: LanguageModel = AiProviderService.getInstance().getModel();
    const targetLength = Math.max(100, maxTokens * 4); // Convert back to characters

    const result = await generateTextWithRetryAsync({
      model,
      prompt: `Summarize the following text concisely while preserving key information. Target length: ~${targetLength} characters.

Text to summarize:
${text}

Provide a concise summary that captures the essential information.`,
    });

    return result.text || "Summary unavailable.";
  } catch (error: unknown) {
    logger.warn("Failed to summarize text field", {
      error: error instanceof Error ? error.message : String(error),
      textLength: text.length,
    });
    // Summary-only fallback: do not include truncated source text
    const lineCount: number = text.split("\n").length;
    const wordCount: number = text.trim().length > 0
      ? text.trim().split(/\s+/).length
      : 0;

    return `Summary unavailable (source text length=${text.length} chars, words=${wordCount}, lines=${lineCount}).`;
  }
}

/**
 * Summarize an array using the LLM.
 */
async function summarizeArray(
  array: unknown[],
  logger: LoggerService,
): Promise<string> {
  try {
    const model: LanguageModel = AiProviderService.getInstance().getModel();
    const arrayPreview = JSON.stringify(array.slice(0, 2), null, 2);
    
    const result = await generateTextWithRetryAsync({
      model,
      prompt: `Summarize the following array of ${array.length} items concisely. 
Describe the type of items, their key properties, and any patterns.

Array preview (first 2 items):
${arrayPreview}

Provide a concise summary of the array contents.`,
    });

    return result.text || `Array with ${array.length} items.`;
  } catch (error: unknown) {
    logger.warn("Failed to summarize array", {
      error: error instanceof Error ? error.message : String(error),
      arrayLength: array.length,
    });
    return `Array with ${array.length} items.`;
  }
}

//#endregion Private Functions
