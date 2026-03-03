export interface ISummarizeOptions {
  maxListItems?: number;
  maxKeys?: number;
  maxStringLength?: number;
  maxDepth?: number;
}

interface ISummarizeContext {
  depth: number;
  options: Required<ISummarizeOptions>;
  stats: {
    truncatedKeys: number;
    truncatedItems: number;
    truncatedStrings: number;
  };
}

const DEFAULT_OPTIONS: Required<ISummarizeOptions> = {
  maxListItems: 3,
  maxKeys: 5,
  maxStringLength: 200,
  maxDepth: 4,
};

function summarizeValue(value: unknown, ctx: ISummarizeContext): unknown {
  if (ctx.depth > ctx.options.maxDepth) {
    return "...";
  }

  if (value === null) {
    return null;
  }

  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    if (value.length > ctx.options.maxStringLength) {
      ctx.stats.truncatedStrings++;
      return value.slice(0, ctx.options.maxStringLength) + "...";
    }
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const childCtx: ISummarizeContext = { ...ctx, depth: ctx.depth + 1 };

    if (value.length <= ctx.options.maxListItems) {
      return value.map((item) => summarizeValue(item, childCtx));
    }

    ctx.stats.truncatedItems += value.length - ctx.options.maxListItems;
    const shown: unknown[] = value
      .slice(0, ctx.options.maxListItems)
      .map((item) => summarizeValue(item, childCtx));

    return [...shown, `...${value.length - ctx.options.maxListItems} more items`];
  }

  if (typeof value === "object") {
    const obj: Record<string, unknown> = value as Record<string, unknown>;
    const keys: string[] = Object.keys(obj);
    const childCtx: ISummarizeContext = { ...ctx, depth: ctx.depth + 1 };

    if (keys.length <= ctx.options.maxKeys) {
      const result: Record<string, unknown> = {};
      for (const key of keys) {
        result[key] = summarizeValue(obj[key], childCtx);
      }
      return result;
    }

    ctx.stats.truncatedKeys += keys.length - ctx.options.maxKeys;
    const shownKeys: string[] = keys.slice(0, ctx.options.maxKeys);
    const omittedKeys: string[] = keys.slice(ctx.options.maxKeys);
    const result: Record<string, unknown> = {};

    for (const key of shownKeys) {
      result[key] = summarizeValue(obj[key], childCtx);
    }

    result["_truncated"] = omittedKeys;
    return result;
  }

  return String(value);
}

export function summarizeJson(data: unknown, options?: ISummarizeOptions): string {
  const opts: Required<ISummarizeOptions> = { ...DEFAULT_OPTIONS, ...options };
  const ctx: ISummarizeContext = {
    depth: 0,
    options: opts,
    stats: { truncatedKeys: 0, truncatedItems: 0, truncatedStrings: 0 },
  };

  const summarized: unknown = summarizeValue(data, ctx);
  return JSON.stringify(summarized, null, 2);
}
