import type { MessagePlatform } from "../shared/types/messaging.types.js";
import type { IRegisteredChannel } from "../shared/types/channel.types.js";
import { extractErrorMessage, ChatNotFoundError } from "./error.js";

export interface ISchedulerNotificationLogger {
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

export interface ISchedulerNotificationDeps {
  hasAdapter: (platform: MessagePlatform) => boolean;
  sendToChannelAsync: (platform: MessagePlatform, channelId: string, message: string) => Promise<void>;
  getKnownTelegramChatIds: () => string[];
  logger: ISchedulerNotificationLogger;
}

export interface ISchedulerNotificationOptions {
  errorPrefix: string;
  taskId?: string;
  fallbackSuccessMessage?: string;
  fallbackFailureMessage?: string;
  logInvalidChannelWarning?: boolean;
}

function getDeliveryTargetKey(platform: MessagePlatform, channelId: string): string {
  return `${platform}:${channelId}`;
}

export async function notifySchedulerChannelsWithDedupAsync(
  channels: IRegisteredChannel[],
  message: string,
  options: ISchedulerNotificationOptions,
  deps: ISchedulerNotificationDeps,
): Promise<void> {
  const deliveredTargets: Set<string> = new Set<string>();

  for (const channel of channels) {
    if (!deps.hasAdapter(channel.platform)) {
      continue;
    }

    const directTargetKey: string = getDeliveryTargetKey(channel.platform, channel.channelId);
    if (deliveredTargets.has(directTargetKey)) {
      continue;
    }

    try {
      await deps.sendToChannelAsync(channel.platform, channel.channelId, message);
      deliveredTargets.add(directTargetKey);
    } catch (sendError: unknown) {
      if (sendError instanceof ChatNotFoundError && channel.platform === "telegram") {
        const knownChatIds: string[] = deps.getKnownTelegramChatIds();

        if (options.logInvalidChannelWarning) {
          deps.logger.warn("Invalid Telegram channel ID, falling back to known chats", {
            invalidChannelId: channel.channelId,
            fallbackChatCount: knownChatIds.length,
          });
        }

        for (const fallbackChatId of knownChatIds) {
          const fallbackTargetKey: string = getDeliveryTargetKey("telegram", fallbackChatId);
          if (deliveredTargets.has(fallbackTargetKey)) {
            continue;
          }

          try {
            await deps.sendToChannelAsync("telegram", fallbackChatId, message);
            deliveredTargets.add(fallbackTargetKey);

            if (options.fallbackSuccessMessage) {
              deps.logger.info(options.fallbackSuccessMessage, { fallbackChatId });
            }
          } catch (fallbackError: unknown) {
            deps.logger.error(options.fallbackFailureMessage ?? "Fallback send also failed", {
              fallbackChatId,
              error: extractErrorMessage(fallbackError),
            });
          }
        }
      } else {
        deps.logger.error(`${options.errorPrefix} ${channel.platform}:${channel.channelId}`, {
          error: extractErrorMessage(sendError),
          taskId: options.taskId,
        });
      }
    }
  }
}
