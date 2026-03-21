import type { LoggerService } from "../services/logger.service.js";
import { resolve429Backoff } from "./retry-after.js";

export async function apply429BackoffAsync(args: {
  logger: LoggerService;
  error: unknown;
  retryAttempt: number;
  logMessage: string;
  logContext?: Record<string, unknown>;
}): Promise<void> {
  const backoff = resolve429Backoff(args.error, args.retryAttempt);

  const hasExplicitBackoff: boolean =
    backoff.retryAfterMs !== null || backoff.rateLimitResetMs !== null;

  args.logger.warn(args.logMessage, {
    ...(args.logContext ?? {}),
    rateLimitRetryAttempt: args.retryAttempt,
    waitMs: backoff.waitMs,
    backoffSource: backoff.source,
    retryAfterMs: backoff.retryAfterMs,
    retryAfterSource: backoff.retryAfterSource,
    rateLimitResetMs: backoff.rateLimitResetMs,
    rateLimitResetSource: backoff.rateLimitResetSource,
    hasExplicitBackoff,
    usingAdaptiveBackoff: !hasExplicitBackoff,
    adaptiveBaseMs: hasExplicitBackoff ? null : 10_000,
  });

  await new Promise<void>((resolve): void => {
    setTimeout(resolve, backoff.waitMs);
  });
}
