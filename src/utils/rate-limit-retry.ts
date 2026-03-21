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

  args.logger.warn(args.logMessage, {
    ...(args.logContext ?? {}),
    waitMs: backoff.waitMs,
    backoffSource: backoff.source,
    retryAfterMs: backoff.retryAfterMs,
    rateLimitResetMs: backoff.rateLimitResetMs,
  });

  await new Promise<void>((resolve): void => {
    setTimeout(resolve, backoff.waitMs);
  });
}
