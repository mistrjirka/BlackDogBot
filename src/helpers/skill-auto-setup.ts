import { SkillLoaderService } from "../services/skill-loader.service.js";
import type { LoggerService } from "../services/logger.service.js";
import type { IConfig } from "../shared/types/index.js";
import * as skillInstaller from "./skill-installer.js";
import * as skillState from "./skill-state.js";
import * as dependencyChecker from "./dependency-checker.js";
import { extractErrorMessage } from "../utils/error.js";

export async function autoSetupSkillsAsync(
  config: IConfig,
  logger: LoggerService,
  notifyAllChannelsAsync: (message: string, errorPrefix: string) => Promise<void>,
): Promise<void> {
  const skillLoaderService: SkillLoaderService = SkillLoaderService.getInstance();
  const skillDependencyConfig: Record<string, unknown> = { ...config };

const notifySkillSetupFailureAsync = async (
  displaySkillName: string,
  safeError: string,
  attemptsBeforeRun: number,
): Promise<void> => {
  if (!config.skills.autoSetupNotify) {
    return;
  }
  const notifyMessage =
    `❌ **Skill Setup Failed**: \`${displaySkillName}\`\n\n` +
    `**Error:**\n\`\`\`\n${safeError}\n\`\`\`\n\n` +
    `${attemptsBeforeRun + 1 < skillState.MAX_AUTO_SETUP_ATTEMPTS ? "Will retry on the next restart after the backoff is due." : "Retry limit reached for this setup metadata; update the skill requirements to retry."}`;
  await notifyAllChannelsAsync(notifyMessage, "Failed to notify");
}

if (config.skills.autoSetup) {
  const skillsNeedingSetup = skillLoaderService.getAllSkills().filter((skill) => {
    const installSteps = skill.frontmatter.metadata?.openclaw?.install ?? [];
    const missingInstallDependencies = new Set([
      ...(skill.state.missingDeps?.bins ?? []),
      ...(skill.state.missingDeps?.anyBins ?? []),
    ]);
    const hasAutomaticInstallStep = installSteps.some(
      (step) => !skillInstaller.isManualInstallStep(step, config.skills.allowedInstallKinds)
        && (step.bins.length === 0 || step.bins.some((bin) => missingInstallDependencies.has(bin))),
    );
    const retryAt = skill.state.nextSetupAttemptAt ? Date.parse(skill.state.nextSetupAttemptAt) : Number.NaN;

    return skill.autoSetupAllowed
      && skill.state.state === "needs-setup"
      && hasAutomaticInstallStep
      && (Number.isNaN(retryAt) || retryAt <= Date.now())
      && dependencyChecker.hasMissingInstallDependencies(skill.state.missingDeps)
      && skill.state.setupAttempts < skillState.MAX_AUTO_SETUP_ATTEMPTS;
  });

  if (skillsNeedingSetup.length > 0) {
    logger.info(`Scheduling auto-setup for ${skillsNeedingSetup.length} skills in background...`);
    void (async (): Promise<void> => {
      for (const skill of skillsNeedingSetup) {
        const displaySkillName: string = skillState.sanitizeSetupError(skill.name);
        try {
          logger.info(`Setting up skill "${displaySkillName}"...`);
          const currentDependencyResult = await dependencyChecker.checkRequirementsAsync(
            skill.frontmatter.metadata?.openclaw?.requires,
            skillDependencyConfig,
          );
          if (currentDependencyResult.satisfied) {
            await skillState.markSkillSetupCompleteAsync(
              skill.name,
              skillState.getSkillSetupFingerprint(skill),
              skill.stateScope,
            );
            logger.info(`Skill "${displaySkillName}" already satisfies its requirements; skipped setup`);
            continue;
          }
          if (!dependencyChecker.hasMissingInstallDependencies(currentDependencyResult.missing)) {
            await skillState.markSkillNeedsSetupAsync(
              skill.name,
              currentDependencyResult.missing,
              skill.state.manualStepsRequired,
              skillState.getSkillSetupFingerprint(skill),
              skill.stateScope,
            );
            continue;
          }

          await skillState.markSkillSetupInProgressAsync(skill.name, skillState.getSkillSetupFingerprint(skill), skill.stateScope);

          const missingInstallDependencies = new Set([
            ...currentDependencyResult.missing.bins,
            ...currentDependencyResult.missing.anyBins,
          ]);
          const installSteps = (skill.frontmatter.metadata?.openclaw?.install ?? []).filter(
            (step) => step.bins.length === 0
              || step.bins.some((bin) => missingInstallDependencies.has(bin)),
          );
          const result = await skillInstaller.executeSkillInstallStepsAsync(
            installSteps,
            config.skills.allowedInstallKinds,
            config.skills.installTimeout
          );

          if (result.success && result.manualStepsRequired.length === 0) {
            const dependencyResult = await dependencyChecker.checkRequirementsAsync(
              skill.frontmatter.metadata?.openclaw?.requires,
              skillDependencyConfig,
            );
            if (!dependencyResult.satisfied) {
              const hasMissingInstallDependencies = dependencyChecker.hasMissingInstallDependencies(dependencyResult.missing);
              if (!hasMissingInstallDependencies) {
                await skillState.markSkillNeedsSetupAsync(
                  skill.name,
                  dependencyResult.missing,
                  [],
                  skillState.getSkillSetupFingerprint(skill),
                  skill.stateScope,
                );
                const missingRequirements: string = skillState.sanitizeSetupError(
                  [...dependencyResult.missing.env, ...dependencyResult.missing.config].join(", "),
                );
                logger.info(`Skill "${displaySkillName}" remains unavailable until requirements are configured`, {
                  missing: missingRequirements,
                });
                if (config.skills.autoSetupNotify) {
                  const notifyMessage =
                    `⚠️ **Skill Needs Configuration**: \`${displaySkillName}\`\n\n` +
                    `Missing requirements: ${missingRequirements}`;
                  await notifyAllChannelsAsync(notifyMessage, "Failed to notify");
                }
                continue;
              }

              const unmetRequirements: string[] = [
                ...dependencyResult.missing.bins,
                ...dependencyResult.missing.anyBins,
                ...dependencyResult.missing.env,
                ...dependencyResult.missing.config,
              ];
              throw new Error(`Install completed but requirements remain unmet: ${unmetRequirements.join(", ")}`);
            }

            await skillState.markSkillSetupCompleteAsync(skill.name, skillState.getSkillSetupFingerprint(skill), skill.stateScope);
            logger.info(`Skill "${displaySkillName}" setup completed`, {
              installed: skillState.sanitizeSetupError(result.installed.join(", ")),
            });

            if (config.skills.autoSetupNotify) {
              const notifyMessage =
                `✅ **Skill Ready**: \`${displaySkillName}\`\n\n` +
                (result.installed.length > 0
                  ? `**Installed:** ${skillState.sanitizeSetupError(result.installed.join(", "))}`
                  : "");
              await notifyAllChannelsAsync(notifyMessage, "Failed to notify");
            }
          } else if (result.success && result.manualStepsRequired.length > 0) {
            const manualDependencyResult = await dependencyChecker.checkRequirementsAsync(
              skill.frontmatter.metadata?.openclaw?.requires,
              skillDependencyConfig,
            );
            await skillState.markSkillNeedsSetupAsync(
              skill.name,
              manualDependencyResult.missing,
              result.manualStepsRequired,
              skillState.getSkillSetupFingerprint(skill),
              skill.stateScope,
            );
            logger.info(`Skill "${displaySkillName}" requires manual steps`, {
              manualSteps: skillState.sanitizeSetupError(result.manualStepsRequired.join("\n")),
            });

            if (config.skills.autoSetupNotify) {
              const notifyMessage =
                `⚠️ **Skill Needs Manual Setup**: \`${displaySkillName}\`\n\n` +
                `This skill requires packages that cannot be auto-installed.\n\n` +
                `**Manual steps:**\n${skillState.sanitizeSetupError(result.manualStepsRequired.map((s, i) => `${i + 1}. ${s}`).join("\n"))}\n\n` +
                `After completing these steps, restart BlackDogBot.`;
              await notifyAllChannelsAsync(notifyMessage, "Failed to notify");
            }
          } else {
            const safeError: string = skillState.sanitizeSetupError(result.error || "Unknown error");
            await skillState.markSkillSetupErrorAsync(skill.name, safeError, skillState.getSkillSetupFingerprint(skill), skill.stateScope);
            logger.error(`Skill "${displaySkillName}" setup failed`, { error: safeError });

            await notifySkillSetupFailureAsync(displaySkillName, safeError, skill.state.setupAttempts);
          }
        } catch (setupError) {
          const safeError: string = skillState.sanitizeSetupError(
            setupError instanceof Error ? setupError.message : String(setupError),
          );
          try {
            await skillState.markSkillSetupErrorAsync(skill.name, safeError, skillState.getSkillSetupFingerprint(skill), skill.stateScope);
          } catch (stateError: unknown) {
            logger.error("Failed to persist skill setup failure", {
              error: skillState.sanitizeSetupError(stateError instanceof Error ? stateError.message : String(stateError)),
            });
          }
          logger.error(`Skill "${displaySkillName}" setup threw error`, { error: safeError });

          await notifySkillSetupFailureAsync(displaySkillName, safeError, skill.state.setupAttempts);
        }
      }
    })().catch((error: unknown) => logger.error("Background skill setup failed", { error: extractErrorMessage(error) }));
  }
}
}
