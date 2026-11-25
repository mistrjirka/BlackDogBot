import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const state = vi.hoisted(() => ({
  data: "",
  events: [] as string[],
  middleware: [] as Array<(socket: unknown, next: (error?: Error) => void) => void>,
  pathFailure: false,
  config: {
    brainInterface: { jwtSecret: "fixture-secret", jwtIssuer: "fixture", jwtAudience: "fixture" },
    logging: { level: "info" }, ai: { provider: "fixture" }, knowledge: {},
    skills: { directories: [], skipOsCheck: true, allowedInstallKinds: [], installTimeout: 1 },
    scheduler: { enabled: true }, telegram: { botToken: "fixture-telegram" }, discord: { botToken: "fixture-discord" },
  },
}));
vi.mock("../../src/env.js", () => ({}));
vi.mock("../../src/migrations/database-path-migrations.js", () => ({
  assertDatabasePathMigrationReadyAsync: async () => { state.events.push("path-check"); if (state.pathFailure) throw new Error("pending path migration"); },
}));
vi.mock("../../src/migrations/data-migrations.js", () => ({
  prepareRuntimeDataAsync: async () => { state.events.push("data-check"); },
}));
vi.mock("../../src/services/config.service.js", () => ({
  ConfigService: { getInstance: () => ({ initializeAsync: async () => { state.events.push("config"); }, getConfig: () => state.config }) },
}));
vi.mock("../../src/services/logger.service.js", () => ({
  LoggerService: { getInstance: () => ({ initializeAsync: async () => {}, info: () => {}, warn: () => {}, error: () => {} }) },
}));
vi.mock("../../src/utils/paths.js", () => ({
  getBaseDir: () => state.data, getJobLogsDir: () => state.data,
  getBrainInterfaceTokenFilePath: () => path.join(state.data, "brain-token"),
  ensureAllDirectoriesAsync: async () => {}, ensureDirectoryExistsAsync: async () => {},
}));
vi.mock("../../src/utils/jwt.js", () => ({ generateJwtToken: () => "fixture" }));
vi.mock("../../src/services/status.service.js", () => ({ StatusService: { getInstance: () => ({ enableCliOutput: () => {} }) } }));
vi.mock("../../src/helpers/litesql.js", () => ({ ensureDefaultDatabaseAsync: async () => { state.events.push("database"); } }));
vi.mock("../../src/services/prompt.service.js", () => ({ PromptService: { getInstance: () => ({ initializeAsync: async () => {} }) } }));
vi.mock("../../src/services/ai-provider.service.js", () => ({
  AiProviderService: { getInstance: () => ({ initializeAsync: async () => { state.events.push("provider"); }, getContextWindow: () => 1000 }) },
}));
vi.mock("../../src/services/embedding.service.js", () => ({ EmbeddingService: {} }));
vi.mock("../../src/services/vector-store.service.js", () => ({ VectorStoreService: {} }));
vi.mock("../../src/services/skill-loader.service.js", () => ({
  SkillLoaderService: { getInstance: () => ({
    loadAllSkillsAsync: async () => { state.events.push("skills"); }, startWatching: async () => { state.events.push("watcher"); },
    getAllSkills: () => [], stopWatching: () => {},
  }) },
}));
vi.mock("../../src/services/messaging.service.js", () => ({
  MessagingService: { getInstance: () => ({
    initializeTelegramOutboxAsync: async () => { state.events.push("outbox"); }, shutdownTelegramOutbox: () => {},
  }) },
}));
vi.mock("../../src/services/channel-registry.service.js", () => ({
  ChannelRegistryService: { getInstance: () => ({ initializeAsync: async () => { state.events.push("channels"); }, getAllChannels: () => [], getNotificationChannels: () => [] }) },
}));
vi.mock("../../src/services/mcp-registry.service.js", () => ({ McpRegistryService: { getInstance: () => ({ initializeAsync: async () => { state.events.push("mcp-registry"); } }) } }));
vi.mock("../../src/services/mcp.service.js", () => ({
  McpService: { getInstance: () => ({ refreshAsync: async () => { state.events.push("mcp"); }, getServerResults: () => new Map(), closeAsync: async () => {} }) },
}));
vi.mock("../../src/helpers/skill-auto-setup.js", () => ({ autoSetupSkillsAsync: async () => { state.events.push("auto-setup"); } }));
vi.mock("../../src/helpers/tool-registry.js", () => ({}));
vi.mock("../../src/agent/main-agent.js", () => ({ MainAgent: { getInstance: () => { state.events.push("main-agent"); return { shutdownAsync: async () => {} }; } } }));
vi.mock("../../src/agent/cron-agent.js", () => ({ CronAgent: { getInstance: () => ({ executeTaskAsync: async () => {} }) } }));
vi.mock("../../src/executors/run-timed-port.js", () => ({ registerRunTimedExecutor: () => { state.events.push("timed-executor"); } }));
vi.mock("../../src/executors/cron-task-executor.js", () => ({ executeCronTaskAsync: async () => {} }));
vi.mock("../../src/utils/scheduler-notifications.js", () => ({ notifySchedulerChannelsWithDedupAsync: async () => {} }));
vi.mock("../../src/platforms/telegram/handler.js", () => ({ TelegramHandler: {} }));
vi.mock("../../src/platforms/telegram/index.js", () => ({
  telegramPlatform: { isEnabled: () => true, initialize: async () => { state.events.push("telegram-updates"); }, stop: async () => {} },
}));
vi.mock("../../src/platforms/discord/index.js", () => ({
  discordPlatform: { isEnabled: () => true, initialize: async () => { state.events.push("discord-gateway"); }, stop: async () => {} },
}));
vi.mock("../../src/services/scheduler.service.js", () => ({
  SchedulerService: { getInstance: () => ({
    setTaskExecutor: () => {}, setOnTaskFailure: () => {}, setOnTaskSkipped: () => {},
    startAsync: async () => { state.events.push("scheduler"); }, stopAsync: async () => {},
  }) },
}));
vi.mock("../../src/brain-interface/service.js", () => ({ BrainInterfaceService: { getInstance: () => ({ initialize: () => { state.events.push("brain-handlers"); } }) } }));
vi.mock("../../src/utils/service-readiness.js", () => ({ reportServiceReadiness: (part: string) => { state.events.push("ready-" + part); } }));
vi.mock("node:http", () => ({
  createServer: () => ({ once: () => {}, off: () => {}, listen: (_port: number, callback: () => void) => { state.events.push("port-bound"); callback(); } }),
}));
vi.mock("socket.io", () => ({
  Server: class {
    use(callback: (socket: unknown, next: (error?: Error) => void) => void): void { state.middleware.push(callback); }
    close(callback: () => void): void { callback(); }
  },
}));

let originalSignals: Map<string, Function[]>;
let approval: Record<string, unknown>;
beforeEach(async () => {
  vi.resetModules();
  state.data = await fs.mkdtemp(path.join(os.tmpdir(), "blackdog-startup-boundary-"));
  state.events = [];
  state.middleware = [];
  state.pathFailure = false;
  originalSignals = new Map(["SIGINT", "SIGTERM", "unhandledRejection"].map(name => [name, process.listeners(name)]));
  vi.stubEnv("INVOCATION_ID", "c".repeat(32));
  vi.spyOn(process, "exit").mockImplementation((() => { state.events.push("exit"); }) as never);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async input => {
    const url = String(input);
    state.events.push("validate-" + url.split("/").pop());
    return new Response(JSON.stringify(url.endsWith("/getMe") ? { ok: true, result: { id: 1 } }
      : url.endsWith("/getWebhookInfo") ? { ok: true, result: { url: "" } } : { id: "1" }));
  }));
  approval = {
    protocolVersion: 1, status: "pending", nonce: "b".repeat(32), revision: "a".repeat(40),
    candidatePath: fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, ""),
    dataDir: state.data, createdAt: new Date().toISOString(),
  };
  await fs.mkdir(path.join(state.data, "deploy"));
  await fs.writeFile(path.join(state.data, "deploy/activation.json"), JSON.stringify(approval), { mode: 0o600 });
});
afterEach(async () => {
  for (const [name, original] of originalSignals) {
    for (const listener of process.listeners(name)) if (!original.includes(listener)) process.off(name, listener as never);
  }
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(state.data, { recursive: true, force: true });
});
async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("Startup condition did not complete: " + state.events.join(", "));
}
const external = ["skills", "watcher", "outbox", "channels", "mcp-registry", "mcp", "auto-setup", "main-agent",
  "telegram-updates", "discord-gateway", "timed-executor", "scheduler", "brain-handlers"];

it("the actual daemon entry holds every external startup boundary until acceptance", async () => {
  await import("../../src/index.js");
  await waitFor(async () => fs.access(path.join(state.data, "deploy/activation-ready.json")).then(() => true, () => false));
  expect(state.events).toContain("port-bound");
  expect(state.events.slice(0, 2)).toEqual(["path-check", "data-check"]);
  expect(state.events.filter(event => external.includes(event))).toEqual([]);
  const before = vi.fn();
  state.middleware[0]({}, before);
  expect(before.mock.calls[0][0]).toBeInstanceOf(Error);
  expect(state.events.filter(event => event.startsWith("validate-"))).toEqual(["validate-getMe", "validate-getWebhookInfo", "validate-@me"]);

  approval = { ...approval, status: "committed", runtimePid: process.pid, invocationId: process.env.INVOCATION_ID };
  await fs.writeFile(path.join(state.data, "deploy/activation.json"), JSON.stringify(approval), { mode: 0o600 });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(state.events.filter(event => external.includes(event))).toEqual([]);
  await fs.writeFile(path.join(state.data, "deploy/activation-release.json"), JSON.stringify(approval), { mode: 0o600 });
  await waitFor(() => state.events.includes("ready-daemon"));
  expect(state.events.filter(event => external.includes(event))).toEqual(external);
  const after = vi.fn();
  state.middleware[0]({}, after);
  expect(after).toHaveBeenCalledWith(undefined);
});

it("pending database recovery stops before readiness and all external startup", async () => {
  state.pathFailure = true;
  await import("../../src/index.js");
  await waitFor(() => state.events.includes("exit"));
  expect(state.events).toEqual(["path-check", "exit"]);
  expect(await fs.access(path.join(state.data, "deploy/activation-ready.json")).then(() => true, () => false)).toBe(false);
});

it("a failed credential validation leaves updates, tasks and Brain unavailable", async () => {
  vi.mocked(fetch).mockRejectedValue(new Error("fixture failure"));
  await import("../../src/index.js");
  await waitFor(() => state.events.includes("exit"));
  expect(state.events.filter(event => external.includes(event))).toEqual([]);
  expect(await fs.access(path.join(state.data, "deploy/activation-ready.json")).then(() => true, () => false)).toBe(false);
  const next = vi.fn();
  state.middleware[0]({}, next);
  expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
});
