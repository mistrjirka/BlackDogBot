import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { MainAgent } from "../../../src/agent/main-agent.js";
import { resetSingletons, silenceLogger } from "../../utils/test-helpers.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { AiProviderService } from "../../../src/services/ai-provider.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { factoryResetAsync } from "../../../src/services/factory-reset.service.js";
import { getSessionFilePath, getSessionsDir } from "../../../src/utils/paths.js";
import type { MessageSender, PhotoSender } from "../../../src/tools/index.js";

let tempDir: string;
let originalHome: string;

const TEST_CONFIG_YAML: string = `
ai:
  provider: openrouter
  openrouter:
    apiKey: test-key
    model: anthropic/claude-sonnet-4
    rateLimits:
      rpm: 60
      tpm: 100000

scheduler:
  enabled: false

knowledge:
  embeddingProvider: local
  embeddingModelPath: onnx-community/Qwen3-Embedding-0.6B-ONNX
  embeddingDtype: q8
  embeddingDevice: cpu
  embeddingOpenRouterModel: nvidia/llama-nemotron-embed-vl-1b-v2:free
  lancedbPath: ~/.blackdogbot/knowledge/lancedb

skills:
  directories: []

logging:
  level: info

services:
  searxngUrl: http://localhost:18731
  crawl4aiUrl: http://localhost:18732
`;

async function initializeServicesAsync(): Promise<void> {
  const loggerService: LoggerService = LoggerService.getInstance();

  await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

  const configService: ConfigService = ConfigService.getInstance();
  const tempConfigPath: string = path.join(tempDir, ".blackdogbot", "config.yaml");

  await configService.initializeAsync(tempConfigPath);

  const aiProviderService: AiProviderService = AiProviderService.getInstance();

  aiProviderService.initialize(configService.getConfig().ai);

  const promptService: PromptService = PromptService.getInstance();

  await promptService.initializeAsync();
}

const messageSender: MessageSender = async (): Promise<string | null> => null;
const photoSender: PhotoSender = async (): Promise<string | null> => null;

function getAgentPrivate(agent: MainAgent): {
  _sessions: Map<string, unknown>;
  _saveSessionAsync: (chatId: string) => Promise<void>;
  _loadSessionAsync: (chatId: string) => Promise<unknown>;
} {
  return agent as unknown as {
    _sessions: Map<string, unknown>;
    _saveSessionAsync: (chatId: string) => Promise<void>;
    _loadSessionAsync: (chatId: string) => Promise<unknown>;
  };
}

describe("Session persistence", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-session-persist-"));
    originalHome = process.env.HOME ?? os.homedir();
    process.env.HOME = tempDir;

    resetSingletons();

    const tempConfigDir: string = path.join(tempDir, ".blackdogbot");
    const tempConfigPath: string = path.join(tempConfigDir, "config.yaml");

    await fs.mkdir(tempConfigDir, { recursive: true });
    await fs.writeFile(tempConfigPath, TEST_CONFIG_YAML, "utf-8");
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    resetSingletons();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("_loadSessionAsync", () => {
    it("should return null when session file does not exist", async () => {
      await initializeServicesAsync();

      const agent: MainAgent = MainAgent.getInstance();
      const priv: ReturnType<typeof getAgentPrivate> = getAgentPrivate(agent);

      const result: unknown = await priv._loadSessionAsync("non-existent-chat");

      expect(result).toBeNull();
    });

    it("should return null and log warning when session file contains corrupt JSON", async () => {
      await initializeServicesAsync();

      const sessionsDir: string = getSessionsDir();
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(getSessionFilePath("corrupt-chat"), "not valid json{{{", "utf-8");

      const agent: MainAgent = MainAgent.getInstance();
      const priv: ReturnType<typeof getAgentPrivate> = getAgentPrivate(agent);

      const result: unknown = await priv._loadSessionAsync("corrupt-chat");

      expect(result).toBeNull();
    });

    it("should return null when messages field is not an array", async () => {
      await initializeServicesAsync();

      const sessionsDir: string = getSessionsDir();
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        getSessionFilePath("invalid-chat"),
        JSON.stringify({ messages: "not-an-array", lastActivityAt: Date.now(), jobCreationMode: null }),
        "utf-8",
      );

      const agent: MainAgent = MainAgent.getInstance();
      const priv: ReturnType<typeof getAgentPrivate> = getAgentPrivate(agent);

      const result: unknown = await priv._loadSessionAsync("invalid-chat");

      expect(result).toBeNull();
    });
  });

  describe("_saveSessionAsync", () => {
    it("should write a session file with correct structure", async () => {
      await initializeServicesAsync();

      const agent: MainAgent = MainAgent.getInstance();
      const priv: ReturnType<typeof getAgentPrivate> = getAgentPrivate(agent);

      const sessionsDir: string = getSessionsDir();
      await fs.mkdir(sessionsDir, { recursive: true });

      const sessions: Map<string, unknown> = (
        agent as unknown as { _sessions: Map<string, unknown> }
      )._sessions;

      sessions.set("test-chat", {
        messages: [
          { role: "user", content: [{ type: "text" as const, text: "hello" }] },
        ],
        lastActivityAt: 1700000000000,
        jobCreationMode: null,
        paused: false,
        resumeResolve: null,
        abortController: null,
        pendingToolRebuild: null,
        toolRebuildCount: 0,
        terminateCurrentRun: false,
      });

      await priv._saveSessionAsync("test-chat");

      const content: string = await fs.readFile(getSessionFilePath("test-chat"), "utf-8");
      const parsed: unknown = JSON.parse(content);

      expect(parsed).toEqual({
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        lastActivityAt: 1700000000000,
        jobCreationMode: null,
      });
    });

    it("should save jobCreationMode when active", async () => {
      await initializeServicesAsync();

      const agent: MainAgent = MainAgent.getInstance();
      const priv: ReturnType<typeof getAgentPrivate> = getAgentPrivate(agent);

      const sessionsDir: string = getSessionsDir();
      await fs.mkdir(sessionsDir, { recursive: true });

      const sessions: Map<string, unknown> = (
        agent as unknown as { _sessions: Map<string, unknown> }
      )._sessions;

      sessions.set("job-chat", {
        messages: [],
        lastActivityAt: 1700000000000,
        jobCreationMode: { jobId: "job-123", startNodeId: "node-abc", auditAttempted: false },
        paused: false,
        resumeResolve: null,
        abortController: null,
        pendingToolRebuild: null,
        toolRebuildCount: 0,
        terminateCurrentRun: false,
      });

      await priv._saveSessionAsync("job-chat");

      const content: string = await fs.readFile(getSessionFilePath("job-chat"), "utf-8");
      const parsed: unknown = JSON.parse(content);

      expect((parsed as Record<string, unknown>).jobCreationMode).toEqual({
        jobId: "job-123",
        startNodeId: "node-abc",
        auditAttempted: false,
      });
    });

    it("should create sessions directory automatically when missing", async () => {
      await initializeServicesAsync();

      const agent: MainAgent = MainAgent.getInstance();
      const priv: ReturnType<typeof getAgentPrivate> = getAgentPrivate(agent);

      const sessions: Map<string, unknown> = (
        agent as unknown as { _sessions: Map<string, unknown> }
      )._sessions;

      sessions.set("auto-dir-chat", {
        messages: [],
        lastActivityAt: 1700000000000,
        jobCreationMode: null,
        paused: false,
        resumeResolve: null,
        abortController: null,
        pendingToolRebuild: null,
        toolRebuildCount: 0,
        terminateCurrentRun: false,
      });

      await priv._saveSessionAsync("auto-dir-chat");

      const exists: boolean = await fs
        .access(getSessionFilePath("auto-dir-chat"))
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);
    });
  });

  describe("save + load round-trip", () => {
    it("should persist and restore a session across _save/_load", async () => {
      await initializeServicesAsync();

      const agent: MainAgent = MainAgent.getInstance();
      const priv: ReturnType<typeof getAgentPrivate> = getAgentPrivate(agent);

      const sessionsDir: string = getSessionsDir();
      await fs.mkdir(sessionsDir, { recursive: true });

      const sessions: Map<string, unknown> = (
        agent as unknown as { _sessions: Map<string, unknown> }
      )._sessions;

      const originalMessages: object[] = [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        { role: "assistant", content: [{ type: "text", text: "hi there!" }] },
      ];

      sessions.set("roundtrip-chat", {
        messages: originalMessages,
        lastActivityAt: 1700000000000,
        jobCreationMode: null,
        paused: false,
        resumeResolve: null,
        abortController: null,
        pendingToolRebuild: null,
        toolRebuildCount: 0,
        terminateCurrentRun: false,
      });

      await priv._saveSessionAsync("roundtrip-chat");

      const loaded: unknown = await priv._loadSessionAsync("roundtrip-chat");

      expect(loaded).toEqual({
        messages: originalMessages,
        lastActivityAt: 1700000000000,
        jobCreationMode: null,
      });
    });

    it("should persist and restore image message buffers", async () => {
      await initializeServicesAsync();

      const agent: MainAgent = MainAgent.getInstance();
      const priv: ReturnType<typeof getAgentPrivate> = getAgentPrivate(agent);

      const sessionsDir: string = getSessionsDir();
      await fs.mkdir(sessionsDir, { recursive: true });

      const imageBuffer: Buffer = Buffer.from([255, 216, 255, 217]);
      const messagesWithImage: object[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "image context" },
            { type: "image", image: imageBuffer, mediaType: "image/jpeg" },
          ],
        },
      ];

      const sessions: Map<string, unknown> = (
        agent as unknown as { _sessions: Map<string, unknown> }
      )._sessions;

      sessions.set("image-roundtrip-chat", {
        messages: messagesWithImage,
        lastActivityAt: 1700000000000,
        jobCreationMode: null,
        paused: false,
        resumeResolve: null,
        abortController: null,
        pendingToolRebuild: null,
        toolRebuildCount: 0,
        terminateCurrentRun: false,
      });

      await priv._saveSessionAsync("image-roundtrip-chat");

      const loaded: unknown = await priv._loadSessionAsync("image-roundtrip-chat");
      const loadedMessages: unknown[] = (loaded as { messages: unknown[] }).messages;
      const loadedContent: unknown[] = (loadedMessages[0] as { content: unknown[] }).content;
      const loadedImagePart: Record<string, unknown> = loadedContent[1] as Record<string, unknown>;

      expect(Buffer.isBuffer(loadedImagePart.image)).toBe(true);
      expect((loadedImagePart.image as Buffer).equals(imageBuffer)).toBe(true);
    });

    it("should restore legacy Node Buffer JSON shape from session files", async () => {
      await initializeServicesAsync();

      const sessionsDir: string = getSessionsDir();
      await fs.mkdir(sessionsDir, { recursive: true });

      await fs.writeFile(
        getSessionFilePath("legacy-buffer-chat"),
        JSON.stringify({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "legacy image" },
                {
                  type: "image",
                  image: {
                    type: "Buffer",
                    data: [255, 216, 255, 217],
                  },
                  mediaType: "image/jpeg",
                },
              ],
            },
          ],
          lastActivityAt: 1700000000000,
          jobCreationMode: null,
        }, null, 2),
        "utf-8",
      );

      const agent: MainAgent = MainAgent.getInstance();
      const priv: ReturnType<typeof getAgentPrivate> = getAgentPrivate(agent);

      const loaded: unknown = await priv._loadSessionAsync("legacy-buffer-chat");
      const loadedMessages: unknown[] = (loaded as { messages: unknown[] }).messages;
      const loadedContent: unknown[] = (loadedMessages[0] as { content: unknown[] }).content;
      const loadedImagePart: Record<string, unknown> = loadedContent[1] as Record<string, unknown>;

      expect(Buffer.isBuffer(loadedImagePart.image)).toBe(true);
      expect((loadedImagePart.image as Buffer).equals(Buffer.from([255, 216, 255, 217]))).toBe(true);
    });
  });

  describe("initializeForChatAsync session restore", () => {
    it("should restore session from disk when initializing for a chat with a saved file", async () => {
      await initializeServicesAsync();

      const sessionsDir: string = getSessionsDir();
      await fs.mkdir(sessionsDir, { recursive: true });

      const savedMessages: object[] = [
        { role: "user", content: [{ type: "text", text: "previous message" }] },
        { role: "assistant", content: [{ type: "text", text: "previous response" }] },
      ];

      await fs.writeFile(
        getSessionFilePath("restored-chat"),
        JSON.stringify({
          messages: savedMessages,
          lastActivityAt: 1700000000000,
          jobCreationMode: null,
        }, null, 2),
        "utf-8",
      );

      const agent: MainAgent = MainAgent.getInstance();

      await agent.initializeForChatAsync("restored-chat", messageSender, photoSender);

      const sessions: Map<string, unknown> = (
        agent as unknown as { _sessions: Map<string, unknown> }
      )._sessions;

      const session: unknown = sessions.get("restored-chat");
      expect(session).not.toBeNull();
      expect((session as Record<string, unknown>).messages).toEqual(savedMessages);
      expect((session as Record<string, unknown>).lastActivityAt).toBe(1700000000000);
    });

    it("should start fresh when no saved session file exists", async () => {
      await initializeServicesAsync();

      const agent: MainAgent = MainAgent.getInstance();

      await agent.initializeForChatAsync("fresh-chat", messageSender, photoSender);

      const sessions: Map<string, unknown> = (
        agent as unknown as { _sessions: Map<string, unknown> }
      )._sessions;

      const session: unknown = sessions.get("fresh-chat");
      expect(session).not.toBeNull();
      expect((session as Record<string, unknown>).messages).toEqual([]);
    });
  });

  describe("clearChatHistory", () => {
    it("should delete the session file when clearing chat history", async () => {
      await initializeServicesAsync();

      const sessionsDir: string = getSessionsDir();
      await fs.mkdir(sessionsDir, { recursive: true });

      await fs.writeFile(
        getSessionFilePath("cleared-chat"),
        JSON.stringify({ messages: [], lastActivityAt: Date.now(), jobCreationMode: null }, null, 2),
        "utf-8",
      );

      const agent: MainAgent = MainAgent.getInstance();

      await agent.initializeForChatAsync("cleared-chat", messageSender, photoSender);
      agent.clearChatHistory("cleared-chat");

      const exists: boolean = await fs
        .access(getSessionFilePath("cleared-chat"))
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(false);
    });
  });

  describe("factoryResetAsync", () => {
    it("should wipe the sessions directory", async () => {
      const sessionsDir: string = getSessionsDir();
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(
        path.join(sessionsDir, "session-1.json"),
        JSON.stringify({ messages: [], lastActivityAt: Date.now(), jobCreationMode: null }),
        "utf-8",
      );

      const logger: LoggerService = LoggerService.getInstance();
      silenceLogger(logger);

      await factoryResetAsync();

      const exists: boolean = await fs
        .access(sessionsDir)
        .then(() => true)
        .catch(() => false);

      expect(exists).toBe(true);
      const files: string[] = await fs.readdir(sessionsDir);
      expect(files).toHaveLength(0);
    });
  });
});
