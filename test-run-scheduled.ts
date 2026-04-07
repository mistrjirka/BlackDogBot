import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

import { ConfigService } from "./src/services/config.service.js";
import { AiProviderService } from "./src/services/ai-provider.service.js";
import { LoggerService } from "./src/services/logger.service.js";
import { SchedulerService } from "./src/services/scheduler.service.js";
import { PromptService } from "./src/services/prompt.service.js";
import { runScheduledTaskTool } from "./src/tools/run-scheduled-task.tool.js";
import { IScheduledTask } from "./src/shared/types/cron.types.js";
import { generateId } from "./src/utils/id.js";

function resetSingletons(): void {
  const services = [
    ConfigService,
    LoggerService,
    AiProviderService,
    SchedulerService,
    PromptService,
  ];
  for (const Service of services) {
    (Service as unknown as { _instance: unknown })._instance = null;
  }
}

async function mainAsync(): Promise<void> {
  console.log("=== Test: runScheduledTaskTool with real LLM ===\n");

  resetSingletons();

  const originalHome = process.env.HOME ?? os.homedir();
  const configPath = path.join(originalHome, ".blackdogbot", "config.yaml");

  const loggerService = LoggerService.getInstance();
  await loggerService.initializeAsync("info", path.join(originalHome, ".blackdogbot", "logs"));

  const configService = ConfigService.getInstance();
  await configService.initializeAsync(configPath);

  const aiProviderService = AiProviderService.getInstance();
  aiProviderService.initialize(configService.getConfig().ai);

  const promptService = PromptService.getInstance();
  await promptService.initializeAsync();

  const scheduler = SchedulerService.getInstance();

  const taskId = "test-hello-task-" + generateId().slice(0, 8);
  const task: IScheduledTask = {
    taskId,
    name: "Test Hello Task",
    description: "A simple test task",
    instructions: "Return exactly: 'Hello, world!'",
    tools: ["send_message"],
    schedule: {
      type: "scheduled",
      intervalMinutes: 1440,
      startHour: null,
      startMinute: null,
      runOnce: true,
    },
    notifyUser: false,
    enabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRunAt: null,
    lastRunStatus: null,
    lastRunError: null,
    messageHistory: [],
    messageSummary: null,
    summaryGeneratedAt: null,
  };

  await scheduler.addTaskAsync(task);
  console.log(`Created test task: ${taskId}\n`);

  try {
    console.log("Executing runScheduledTaskTool...\n");

    const result = await runScheduledTaskTool.execute({
      taskId,
      sendToUser: false,
    });

    console.log("=== RESULT ===\n");
    console.log(result.markdown);
    console.log("\n=== END ===");

    console.log(`\nSuccess: ${result.success}`);
  } catch (error) {
    console.error("Error executing tool:", error);
  } finally {
    await scheduler.removeTaskAsync(taskId);
    console.log(`\nCleaned up test task: ${taskId}`);
  }
}

mainAsync().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
