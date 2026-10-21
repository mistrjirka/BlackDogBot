import { type Tool, type ToolExecutionOptions, type ToolSet } from "ai";
import { type ZodType, z } from "zod";

import {
  CAPTURE_THRESHOLD_CHARS,
  PREVIEW_MAX_CHARS,
} from "../shared/limits.js";

/**
 * Blackboard variable store (Phase 1 — Blackboard Core).
 *
 * Tool results that cross a size threshold are captured into a per-run store and
 * replaced in context with a compact "stub". Tool inputs may then reference a
 * stored variable by name instead of re-emitting the whole blob. The model never
 * names variables (names are assigned per result) and never re-reads/re-emits a
 * blob — that is the token goal (see PTC-SPEC.md).
 *
 * Capture stores the PRIMARY PAYLOAD, not tool-result wrappers: when a plain-object
 * result carries its data in one dominant array/string field, that field value is
 * what gets stored (and what a ref resolves to); the wrapper's scalar extras live
 * in the stub's `meta`. Normalized keys are the canonical downstream form — they
 * are what tools receive and what `itemSchema` describes, so column names for
 * writes should be taken from `itemSchema`. Tools must not mutate resolved inputs
 * (resolved values alias the stored value; per-table `execute` spreads rows anew).
 *
 * No async methods → no Async suffix on members.
 */

//#region Constants

export { CAPTURE_THRESHOLD_CHARS, PREVIEW_MAX_CHARS };

/** Maximum number of variables retained in a single run (FIFO eviction beyond this). */
export const MAX_VARIABLES_PER_RUN: number = 50;

/** Per-variable hard cap; data above this is never truncated, so it is stored inline. */
export const MAX_VARIABLE_BYTES: number = 1024 * 1024;

/** Total bytes across all variables in a run; oldest are evicted on overflow. */
export const MAX_TOTAL_BYTES: number = 8 * 1024 * 1024;

/** Number of array items sampled when inferring an itemSchema. */
export const ITEM_SCHEMA_SAMPLE_SIZE: number = 5;

/** itemSchema recursion depth; objects deeper than this collapse to "object". */
export const ITEM_SCHEMA_MAX_DEPTH: number = 3;

/**
 * JS reserved words / ES keywords. A normalized key that lands on one gets a
 * trailing `_` so dot-access never traps on a language keyword (e.g. `class`).
 * Frozen: membership is queried at capture time, never mutated.
 */
const _RESERVED_WORDS: ReadonlySet<string> = new Set([
  "break", "case", "catch", "class", "const", "continue", "default", "delete",
  "do", "else", "enum", "export", "extends", "false", "finally", "for", "function",
  "if", "import", "in", "instanceof", "new", "null", "return", "super", "switch",
  "this", "throw", "true", "try", "typeof", "var", "void", "while", "with", "yield",
  "await", "let", "static", "of", "get", "set", "implements", "interface",
  "package", "private", "protected", "public",
]);

//#endregion Constants

//#region Interfaces

/** The single reference shape a tool argument may take to point at a stored variable. */
export interface IVariableRef {
  type: "variable";
  name: string;
}

/** Structured error returned (NOT thrown) when a reference names an unknown/evicted variable. */
export interface IUnknownVariableError {
  ok: false;
  error: "unknown_variable";
  message: string;
  available: string[];
}

/** Result of resolving references in a tool input. */
export interface IResolveResult {
  input: unknown;
  error?: IUnknownVariableError;
}

/** One captured variable: the (key-normalized) value, its serialized size, and wrapper extras. */
interface ICapturedVariable {
  value: unknown;
  sizeBytes: number;
  /** Scalar wrapper fields preserved at capture when the payload was extracted (FIX-1); omitted otherwise. */
  meta?: Record<string, string | number | boolean | null>;
}

/** Shape of a captured-variable stub shown to the model instead of the full blob. */
interface IVariableStub {
  variable: string;
  type: "array" | "object" | "string" | "number" | "boolean";
  count?: number;
  sizeBytes: number;
  itemSchema?: unknown;
  preview?: unknown;
  /** Wrapper extras (e.g. pagination) when the payload was extracted; omitted when empty. */
  meta?: Record<string, string | number | boolean | null>;
  note: string;
  total?: number;
}

//#endregion Interfaces

//#region Public

/**
 * Reference description shown adjacent to each variable-capable union branch so
 * the model can reason about which option to pick.
 */
export const VARIABLE_REF_DESCRIPTION: string =
  "Stored blackboard reference. Use this exact object only in an input field whose schema advertises variable-reference support; it is not a shell environment variable. Pass the object as-is, never stringify it or use $NAME syntax.";

/**
 * zod schema for a variable reference. Strict object (`additionalProperties:false`)
 * — OpenAI strict-subset and llama.cpp grammar compatible. `name` is required and
 * non-empty.
 */
export const variableRefSchema: ZodType<IVariableRef> = z.object({
  type: z.enum(["variable"]),
  name: z.string().min(1),
}).strict();

/**
 * Per-run blackboard. Large tool results are captured here (as stubs) and small
 * ones pass through untouched. Construct one per agent run.
 */
export class VariableStore {
  /** Insertion order = FIFO eviction order. */
  private readonly _variables: Map<string, ICapturedVariable> = new Map();

  /** Run-global capture counter; names are `<toolName>_<n>`. */
  private _counter: number = 0;

  constructor() {
    // No arguments: the store is a per-run scratch space, created by the agent.
  }

  /**
   * Capture `result` under an auto-assigned name and return a stub, or return
   * `result` unchanged when it should not be stored. Order of operations:
   *   1. null/undefined → return as-is (nothing to store).
   *   2. JSON.stringify failure (circular refs / non-serializable) → return original.
   *   3. sizeBytes > MAX_VARIABLE_BYTES → return original (never truncate data to write).
   *   4. json.length < CAPTURE_THRESHOLD_CHARS → return original (below-threshold inline).
   *   5. extract the primary payload when `result` is a dominated wrapper object (FIX-1),
   *      normalize keys, store under `<toolName>_<n>` (run-global counter).
   *   6. evict FIFO while over the variable count cap or the total byte cap.
   *   7. return the stub describing the captured (payload) value.
   */
  maybeCapture(toolName: string, result: unknown): unknown {
    // 1. null/undefined carry no blob to store.
    if (result === null || result === undefined) {
      return result;
    }

    // 2. Non-serializable (e.g. circular) → leave the original result inline.
    let json: string;
    try {
      json = JSON.stringify(result);
    } catch {
      return result;
    }
    if (json === undefined) {
      // stringify returned undefined for e.g. functions/symbols → not storable.
      return result;
    }

    // 3. Oversized single variable: store inline, never truncate data headed for a write.
    const sizeBytes: number = Buffer.byteLength(json, "utf8");
    if (sizeBytes > MAX_VARIABLE_BYTES) {
      return result;
    }

    // 4. Below threshold: inline exactly as before (decision — no below-threshold capture).
    if (json.length < CAPTURE_THRESHOLD_CHARS) {
      return result;
    }

    // 5. FIX-1: when the result is a plain-object wrapper dominated by one payload
    //    field, store the FIELD VALUE so a ref resolves to what the sinks consume.
    //    Normalize keys on the payload; sizeBytes is measured post-normalization.
    const extraction: IExtraction = _extractPrimaryPayload(result, sizeBytes);
    const normalized: unknown = _normalizeKeys(extraction.payload);
    const storedSizeBytes: number = Buffer.byteLength(JSON.stringify(normalized) ?? json, "utf8");
    const name: string = `${toolName}_${++this._counter}`;
    if (extraction.meta === undefined) {
      this._variables.set(name, { value: normalized, sizeBytes: storedSizeBytes });
    } else {
      this._variables.set(name, { value: normalized, sizeBytes: storedSizeBytes, meta: extraction.meta });
    }

    // 6. Evict oldest (FIFO) while over either cap (a minimum one eviction when triggered).
    this._evictIfNeeded();

    // 7. Stub replaces the blob in context; it describes the payload. `total` still
    //    passes through from the WHOLE result so wrapper counters survive extraction.
    return _buildStub(name, normalized, storedSizeBytes, extraction.meta, extraction.extracted ? result : undefined);
  }

  /**
   * Shallow (top-level fields only) resolution of variable references in a tool
   * input. Returns the resolved input, or an error when a reference names an
   * unknown/evicted variable (the wrapper turns that into a tool result).
   */
  resolveInput(input: unknown): IResolveResult {
    // 1. Only plain objects can carry named fields to resolve.
    if (!_isPlainObject(input)) {
      return { input };
    }

    const resolvedFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      const fieldResolution: { value: unknown; error?: IUnknownVariableError } = _resolveField(value, this);
      if (fieldResolution.error) {
        // All-or-nothing: a single unknown reference fails the whole resolve so the
        // wrapper returns the structured error and the model recovers by picking a name.
        return { input, error: fieldResolution.error };
      }
      resolvedFields[key] = fieldResolution.value;
    }

    return { input: resolvedFields };
  }

  /** Names of all currently retained variables, in capture (FIFO) order. */
  names(): string[] {
    return Array.from(this._variables.keys());
  }

  /** Value captured under `name`, or undefined when unknown/evicted. */
  get(name: string): unknown | undefined {
    return this._variables.get(name)?.value;
  }

  /**
   * Evict oldest (FIFO) variables while over the count cap or the total-byte cap.
   * Running totals are recomputed from the map so the logic is self-contained.
   */
  private _evictIfNeeded(): void {
    let totalBytes: number = 0;
    for (const { sizeBytes } of this._variables.values()) {
      totalBytes += sizeBytes;
    }

    // `>` (not `>=`) so the cap retains exactly MAX_VARIABLES_PER_RUN entries; a
    // `>=` check would evict on reaching the cap and retain only 49.
    while (
      this._variables.size > MAX_VARIABLES_PER_RUN ||
      totalBytes > MAX_TOTAL_BYTES
    ) {
      const firstKey: string | undefined = this._variables.keys().next().value;
      if (firstKey === undefined) {
        break;
      }
      const removed: ICapturedVariable | undefined = this._variables.get(firstKey);
      this._variables.delete(firstKey);
      if (removed) {
        totalBytes -= removed.sizeBytes;
      }
    }
  }
}

/**
 * Wraps a whole tool set so every executable tool:
 *   - resolves variable references in its input before `execute`, and
 *   - captures its result into the run-global store (as a stub) after `execute`.
 *
 * The variable wrapper is meant to be OUTERMOST (wraps the reasoning wrapper), so
 * refs resolve before reasoning is stripped and the inner tool sees clean input.
 * The store is read lazily via `getStore` at execution time, so hot-reloaded tool
 * rebuilds automatically see the live store.
 */
export function wrapToolSetWithVariables(
  tools: ToolSet,
  getStore: () => VariableStore | null,
): ToolSet {
  const wrapped: ToolSet = {};

  for (const [toolName, rawTool] of Object.entries(tools)) {
    const toolDef: Tool<unknown, unknown> = rawTool as Tool<unknown, unknown>;
    const originalExecute = toolDef.execute;

    // Tools without an execute implementation are passed through untouched.
    if (!originalExecute) {
      wrapped[toolName] = rawTool;
      continue;
    }

    // toModelOutput tools return a model-ready result already; capture would double-wrap.
    const captureExcluded: boolean = typeof toolDef.toModelOutput === "function";

    wrapped[toolName] = {
      ...toolDef,
      execute: async (input: unknown, options: ToolExecutionOptions<never>): Promise<unknown> => {
        const store: VariableStore | null = getStore();

        // Resolve references before execute. When there is no store (should not happen
        // mid-run) a ref-shaped field is still a structured unknown-variable error —
        // never pass the literal ref JSON through to `execute`.
        const resolved: IResolveResult = store ? store.resolveInput(input) : _resolveWithoutStore(input);
        if (resolved.error) {
          // Tool result, NOT a throw — the model recovers from the listed names.
          return resolved.error;
        }

        const result: unknown = await originalExecute(resolved.input, options);

        // Preserve raw (already model-ready) results and skip capture for them.
        if (!store || captureExcluded) {
          return result;
        }

        return store.maybeCapture(toolName, result);
      },
    } as Tool<unknown, unknown>;
  }

  return wrapped;
}

//#endregion Public

//#region Private functions

/** True only for object literals / JSON.parse results (not arrays, not class instances). */
function _isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.getPrototypeOf(value) === Object.prototype;
}

/** A JSON scalar that may be preserved in a stub's `meta` (FIX-1 wrapper extras). */
type ScalarMetaValue = string | number | boolean | null;

/** Result of FIX-1 primary-payload extraction at capture. */
interface IExtraction {
  /** The value to store (the payload field, or the whole result when not extracted). */
  payload: unknown;
  /** Remaining scalar wrapper fields, in original key order (absent when not extracted or empty). */
  meta?: Record<string, ScalarMetaValue>;
  /** True when `payload` is a field value rather than the whole result. */
  extracted: boolean;
}

/** True when `value` is a JSON scalar (string/number/boolean/null) eligible for `meta`. */
function _isScalarMetaValue(value: unknown): value is ScalarMetaValue {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

/**
 * FIX-1 primary-payload extraction (capture-side). When a plain-object tool result
 * carries its data in one dominant field, return that FIELD VALUE as the payload so
 * a ref resolves to exactly what the sinks consume (rows array for `write_table_*`,
 * text for `write_file`/`add_knowledge`). Array rule first, then string rule; any
 * other shape (multiple arrays, ambiguous, no dominant field) captures the whole
 * object exactly as before.
 */
function _extractPrimaryPayload(result: unknown, wholeBytes: number): IExtraction {
  if (!_isPlainObject(result)) {
    return { payload: result, extracted: false };
  }
  const entries: Array<[string, unknown]> = Object.entries(result);

  // Array rule: exactly one array-valued field holding >= 50% of the serialized bytes.
  const arrayFields: Array<[string, unknown]> = entries.filter(([, value]) => Array.isArray(value));
  if (arrayFields.length === 1) {
    const [key, value] = arrayFields[0];
    if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") >= wholeBytes / 2) {
      return { payload: value, meta: _extractMeta(result, key), extracted: true };
    }
    return { payload: result, extracted: false };
  }
  if (arrayFields.length > 1) {
    return { payload: result, extracted: false };
  }

  // Explicit primary fields for common wrappers. Prefer stdout over stderr and
  // content over message even when the secondary string is larger.
  if (typeof result.stdout === "string" || typeof result.stderr === "string") {
    const stdoutText: string = typeof result.stdout === "string" ? result.stdout : "";
    const stderrText: string = typeof result.stderr === "string" ? result.stderr : "";
    const stdoutBytes: number = Buffer.byteLength(stdoutText, "utf8");
    const stderrBytes: number = Buffer.byteLength(stderrText, "utf8");
    if (stdoutBytes + stderrBytes >= wholeBytes / 2) {
      // Keep both channels readable in the stored payload; stderr alone is
      // often the only diagnostic on a failed command.
      const combined: string = stderrText.length > 0
        ? `${stdoutText}${stdoutText.length > 0 ? "\n" : ""}[stderr]\n${stderrText}`
        : stdoutText;
      return { payload: combined, meta: _extractMeta(result, "stdout"), extracted: true };
    }
  }

  if (typeof result.content === "string"
    && Buffer.byteLength(result.content, "utf8") >= wholeBytes / 2) {
    return { payload: result.content, meta: _extractMeta(result, "content"), extracted: true };
  }

  // Generic string rule: the largest string-valued field must hold >= 50% of the
  // serialized bytes.
  const stringFields: Array<[string, unknown]> = entries
    .filter(([, value]) => typeof value === "string")
    .sort((a, b) => Buffer.byteLength(JSON.stringify(b[1]) ?? "", "utf8")
      - Buffer.byteLength(JSON.stringify(a[1]) ?? "", "utf8"));
  if (stringFields.length > 0) {
    const [key, value] = stringFields[0];
    if (Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") >= wholeBytes / 2) {
      return { payload: value, meta: _extractMeta(result, key), extracted: true };
    }
  }
  return { payload: result, extracted: false };
}

/**
 * Collect the wrapper's remaining scalar fields (original key order) for the stub's
 * `meta`: at most 8 fields, dropping trailing fields while the serialized form
 * exceeds 500 chars. Returns undefined when nothing remains (meta then omitted).
 */
function _extractMeta(result: Record<string, unknown>, payloadKey: string): Record<string, ScalarMetaValue> | undefined {
  const priorityKeys: string[] = [
    "exitCode", "status", "error", "timedOut", "durationMs", "signal", "stderr", "message",
  ];
  const orderedKeys: string[] = [
    ...priorityKeys.filter((key: string): boolean => key in result && key !== payloadKey),
    ...Object.keys(result).filter((key: string): boolean => key !== payloadKey && !priorityKeys.includes(key)),
  ];

  const meta: Record<string, ScalarMetaValue> = {};
  for (const key of orderedKeys) {
    const value: unknown = result[key];
    if (!_isScalarMetaValue(value)) {
      continue;
    }

    const normalizedValue: ScalarMetaValue = typeof value === "string" && value.length > 300
      ? `${value.slice(0, 300)}…`
      : value;

    meta[key] = normalizedValue;
    if (Object.keys(meta).length >= 10) {
      break;
    }

    while (JSON.stringify(meta).length > 1000 && Object.keys(meta).length > 1) {
      const lastKey: string | undefined = Object.keys(meta).at(-1);
      if (lastKey === undefined) {
        break;
      }
      delete meta[lastKey];
    }
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

/** True only for a well-formed variable reference (exactly `type` + `name`).
 * Deferred edge cluster (no change — documented, Phase 2 owns): extra-key refs are
 * rejected upstream by the schema's `.strict()` (framework error, no `available[]`);
 * empty names are rejected by `.min(1)`; stringified refs with extra keys stay literal
 * strings; nested refs pass through unresolved (resolution is shallow by design). */
function _isVariableRef(value: unknown): value is IVariableRef {
  if (!_isPlainObject(value)) {
    return false;
  }
  const keys: string[] = Object.keys(value);
  return (
    keys.length === 2 &&
    value.type === "variable" &&
    typeof value.name === "string"
  );
}

/**
 * Resolve one top-level field value: unwrap a variable reference (object form or
 * JSON-stringified form) to its stored value, or pass it through unchanged.
 * Structured as one helper so a future numeric-string-coerce branch (rule 3) can
 * be added without refactoring the callers.
 */
function _resolveField(
  value: unknown,
  store: VariableStore,
): { value: unknown; error?: IUnknownVariableError } {
  // Rule 1: object-shaped reference.
  if (_isVariableRef(value)) {
    return _lookupVariable(value.name, store);
  }

  // Rule 2: string that parses to exactly a reference shape (the observed habit of
  // stringifying the ref into the string branch of a union).
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (_isVariableRef(parsed)) {
        return _lookupVariable(parsed.name, store);
      }
    } catch {
      // Not JSON — falls through to literal passthrough.
    }
  }

  // Rule 3 (numeric-string coerce) intentionally NOT implemented: no string|number
  // union arg exists in this batch.

  return { value };
}

function _lookupVariable(
  name: string,
  store: VariableStore,
): { value: unknown; error?: IUnknownVariableError } {
  const found: unknown = store.get(name);
  if (found === undefined) {
    return {
      value: undefined,
      error: {
        ok: false,
        error: "unknown_variable",
        message: `Variable "${name}" is unknown or was evicted. Available variables: ${store.names().join(", ") || "(none)"}`,
        available: store.names(),
      },
    };
  }
  return { value: found };
}

/**
 * Null-store resolution (C1.1 belt-and-braces): with no store there is nothing to
 * resolve, but a ref-shaped top-level field still yields the structured
 * unknown-variable error (available: []) instead of passing the literal ref JSON
 * into `execute`.
 */
function _resolveWithoutStore(input: unknown): IResolveResult {
  if (_isPlainObject(input)) {
    for (const value of Object.values(input)) {
      let candidate: unknown = value;
      if (typeof value === "string") {
        try {
          candidate = JSON.parse(value);
        } catch {
          continue;
        }
      }
      if (_isVariableRef(candidate)) {
        return {
          input,
          error: {
            ok: false,
            error: "unknown_variable",
            message: "No variable store for this run.",
            available: [],
          },
        };
      }
    }
  }
  return { input };
}

/**
 * Deep-normalize object keys to valid JS identifiers so dot-access never traps.
 * Arrays map their elements; only plain objects are rewritten (class instances are
 * stored unmodified — an edge case, documented). Done once at capture so stored
 * data, preview and itemSchema stay consistent.
 */
function _normalizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => _normalizeKeys(item));
  }

  if (!_isPlainObject(value)) {
    // Atomic, class instance, or other non-literal object → unchanged.
    return value;
  }

  const out: Record<string, unknown> = {};
  const produced: Set<string> = new Set();

  for (const [key, val] of Object.entries(value)) {
    const normalizedKey: string = _normalizeKeyName(key, produced);
    produced.add(normalizedKey);
    // defineProperty (not assignment) so a `__proto__` key becomes an own data
    // property instead of mutating/reading the prototype.
    Object.defineProperty(out, normalizedKey, {
      value: _normalizeKeys(val),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  return out;
}

/** Normalize a single key: sanitize, fix digit-leading and reserved words, resolve collisions. */
function _normalizeKeyName(key: string, produced: Set<string>): string {
  let normalized: string = key.replace(/[^A-Za-z0-9_]/g, "_");

  // Digit-leading identifiers are invalid → prefix underscore.
  if (/^[0-9]/.test(normalized)) {
    normalized = `_${normalized}`;
  }

  // Reserved word → suffix underscore so `i.class` never throws.
  if (_RESERVED_WORDS.has(normalized)) {
    normalized = `${normalized}_`;
  }

  // Collision within the same object → suffix _2, _3, … (e.g. `a-b` and `a.b` both
  // sanitize to `a_b`, so the second becomes `a_b_2`).
  let candidate: string = normalized;
  let suffix: number = 2;
  while (produced.has(candidate)) {
    candidate = `${normalized}_${suffix++}`;
  }

  return candidate;
}

//#endregion Private

//#region Stub builder

/** Coerce a captured value to its stub `type` discriminator. */
function _inferValueType(value: unknown): IVariableStub["type"] {
  if (Array.isArray(value)) {
    return "array";
  }
  if (_isPlainObject(value)) {
    return "object";
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

/** Atomic leaf type token used inside itemSchema (null leaf → "null", a spec gap). */
function _inferAtomicType(value: unknown): "string" | "number" | "boolean" | "null" {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "null";
  }
}

/**
 * Infer a compact JSON-Schema-style description of one item (array) or the object
 * itself (plain object), recursing until all leaves are atomic. `depth` is the
 * nesting depth of `value`; `value` at depth 1 is an array item's top level, so a
 * 3-deep object's children are at depths 2 and 3 and their children (depth 4)
 * collapse to the literal "object".
 */
function _inferItemSchema(value: unknown, depth: number): unknown {
  if (depth > ITEM_SCHEMA_MAX_DEPTH) {
    return "object";
  }

  if (Array.isArray(value)) {
    const items: unknown = _inferArrayItemsSchema(value, depth);
    return items === undefined ? { type: "array" } : { type: "array", items };
  }

  if (_isPlainObject(value)) {
    const properties: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      properties[key] = _inferItemSchema(val, depth + 1);
    }
    return { type: "object", properties };
  }

  return _inferAtomicType(value);
}

/**
 * Union schema across ≤ ITEM_SCHEMA_SAMPLE_SIZE array items: union of keys, a `?`
 * suffix on keys absent in some sampled item, and (for a field) the type of the
 * first non-null sample when atomic types mix across samples.
 */
function _inferArrayItemsSchema(samples: unknown[], depth: number): unknown {
  const limited: unknown[] = samples.slice(0, ITEM_SCHEMA_SAMPLE_SIZE);
  if (limited.length === 0) {
    // Empty array: omit `items` (never fabricate a type for no data).
    return undefined;
  }
  const objectSamples: Record<string, unknown>[] = limited.filter(_isPlainObject) as Record<string, unknown>[];

  if (objectSamples.length === 0) {
    // Homogeneous non-object array: describe the first element.
    return _inferItemSchema(limited[0], depth);
  }

  const properties: Record<string, unknown> = {};
  const keyOrder: string[] = [];
  const seen: Set<string> = new Set();

  for (const sample of objectSamples) {
    for (const key of Object.keys(sample)) {
      if (!seen.has(key)) {
        seen.add(key);
        keyOrder.push(key);
      }
    }
  }

  for (const key of keyOrder) {
    const presentInAll: boolean = objectSamples.every((s) => Object.prototype.hasOwnProperty.call(s, key));
    const fieldValues: unknown[] = objectSamples
      .filter((s) => Object.prototype.hasOwnProperty.call(s, key))
      .map((s) => s[key]);
    // A field value is a property of a depth-`depth` item, so infer it at depth+1.
    const base: unknown = _inferFieldSchema(fieldValues, depth + 1);
    // Partial (`?`) keys: string bases take the suffix; object bases take an
    // `optional:true` flag (never stringify an object into "[object Object]?").
    if (presentInAll) {
      properties[key] = base;
    } else if (typeof base === "string") {
      properties[key] = `${base}?`;
    } else if (_isPlainObject(base)) {
      properties[key] = { ...base, optional: true };
    } else {
      properties[key] = base;
    }
  }

  return { type: "object", properties };
}

/** Infer a single field's schema from its values across sampled items. */
function _inferFieldSchema(values: unknown[], depth: number): unknown {
  const nonNull: unknown[] = values.filter((v) => v !== null);
  const sample: unknown = nonNull[0] ?? values[0];

  if (sample === undefined || sample === null || typeof sample !== "object") {
    // All atomic (or all null) → type of the first non-null sample.
    return _inferAtomicType(sample ?? null);
  }

  if (Array.isArray(sample)) {
    const items: unknown = _inferArrayItemsSchema(sample, depth);
    return items === undefined ? { type: "array" } : { type: "array", items };
  }

  // Plain object at this depth → its properties live at depth+1.
  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(sample)) {
    properties[key] = _inferItemSchema((sample as Record<string, unknown>)[key], depth + 1);
  }
  return { type: "object", properties };
}

/**
 * Stub preview: arrays → first 1–2 items (bounded to PREVIEW_MAX_CHARS total);
 * objects/strings → truncated JSON ≤ PREVIEW_MAX_CHARS.
 */
function _buildPreview(value: unknown, type: IVariableStub["type"]): unknown {
  if (type === "array") {
    const items: unknown[] = (value as unknown[]).slice(0, 2);
    const serialized: string = JSON.stringify(items);
    if (serialized.length <= PREVIEW_MAX_CHARS) {
      return items;
    }
    // Items too large to fit as an array preview → fall back to a bounded string.
    return serialized.slice(0, PREVIEW_MAX_CHARS);
  }

  const serialized: string = JSON.stringify(value);
  return serialized.length <= PREVIEW_MAX_CHARS
    ? serialized
    : `${serialized.slice(0, PREVIEW_MAX_CHARS)}…`;
}

/**
 * Build the spec §2.1 stub shape: variable/type/count/sizeBytes/itemSchema?/
 * preview/meta?/note, plus `total` when the (whole) result carries a numeric
 * top-level totalCount | total | matchingTotal. `type`/`count`/`itemSchema`/`preview`
 * always describe the STORED (payload) value; `total` is read from `totalFrom`
 * (the whole pre-extraction result) when extraction fired, else from the value.
 */
function _buildStub(
  name: string,
  value: unknown,
  sizeBytes: number,
  meta?: Record<string, ScalarMetaValue>,
  totalFrom?: unknown,
): IVariableStub {
  const type: IVariableStub["type"] = _inferValueType(value);

  const stub: IVariableStub = {
    variable: name,
    type,
    sizeBytes,
    note: `Full data is stored in this run's blackboard, not a shell variable. Use inspect_variable with name "${name}" to read it, or {"type":"variable","name":"${name}"} only in an input field that supports references; run_cmd cannot read it.`,
  };

  if (type === "array") {
    stub.count = (value as unknown[]).length;
  }

  // itemSchema for object and array variables only (scalars carry no structure).
  if (type === "object" || type === "array") {
    stub.itemSchema = _inferItemSchema(value, 1);
  }

  stub.preview = _buildPreview(value, type);

  if (meta !== undefined) {
    stub.meta = meta;
  }

  // total passthrough: only for a plain object with a numeric top-level counter.
  const totalSource: unknown = totalFrom ?? value;
  if (_isPlainObject(totalSource)) {
    for (const key of ["totalCount", "total", "matchingTotal"]) {
      const candidate: unknown = totalSource[key];
      if (typeof candidate === "number") {
        stub.total = candidate;
        break;
      }
    }
  }

  return stub;
}

//#endregion Stub builder
