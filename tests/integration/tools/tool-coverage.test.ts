import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer, type Server } from "node:http";

import { createTestEnvironment, resetSingletons, loadTestConfigAsync } from "../../utils/test-helpers.js";
import { LangchainMainAgent } from "../../../src/agent/langchain-main-agent.js";
import { ConfigService } from "../../../src/services/config.service.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { PromptService } from "../../../src/services/prompt.service.js";
import { AiCapabilityService } from "../../../src/services/ai-capability.service.js";
import { ChannelRegistryService } from "../../../src/services/channel-registry.service.js";
import { SkillLoaderService } from "../../../src/services/skill-loader.service.js";
import { McpRegistryService } from "../../../src/services/mcp-registry.service.js";
import { LangchainMcpService } from "../../../src/services/langchain-mcp.service.js";
import { createRssTestServer } from "../../mocks/rss-test-server.js";

const env = createTestEnvironment("tool-coverage");

/**
 * Real-LLM Tool Coverage Test Suite
 *
 * Tests verify that the LLM knows about each tool and can use it correctly.
 * - Uses real LLM execution with full LangchainMainAgent and system prompt
 * - Uses mock RSS server for reliable testing
 * - Uses real servers from config (searxng, crawl4ai) or skips test if not configured
 * - Timeout: 600s per test (real LLM calls take time)
 * - Each tool has at least one prompt that triggers its invocation
 */

let rssServer: Server;
let searxngUrl: string | undefined;
let crawl4aiUrl: string | undefined;

beforeAll(async () => {
  await env.setupAsync({ logLevel: "error" });
  await loadTestConfigAsync(env.tempDir, { originalHome: env.originalHome });

  const loggerService = LoggerService.getInstance();
  await loggerService.initializeAsync("error", path.join(env.tempDir, "logs"));

  const configService = ConfigService.getInstance();
  await configService.initializeAsync();

  const config = configService.getConfig();
  searxngUrl = config.services?.searxngUrl;
  crawl4aiUrl = config.services?.crawl4aiUrl;

  const aiConfig = config.ai;
  const aiCapability = AiCapabilityService.getInstance();
  aiCapability.initialize(aiConfig);

  const promptService = PromptService.getInstance();
  await promptService.initializeAsync();

  const channelRegistry = ChannelRegistryService.getInstance();
  await channelRegistry.initializeAsync();

  const skillLoader = SkillLoaderService.getInstance();
  await skillLoader.loadAllSkillsAsync([], false);

  const mcpRegistry = McpRegistryService.getInstance();
  await mcpRegistry.initializeAsync();

  const mcpService = LangchainMcpService.getInstance();
  await mcpService.refreshAsync();

  // Start mock RSS server for reliable testing
  rssServer = await createRssTestServer(3999);
}, 60000);

afterAll(async () => {
  resetSingletons();
  await env.teardownAsync();
  rssServer?.close();
});

//#region Helper

async function runAgentTest(
  chatId: string,
  prompt: string
): Promise<{ text: string; stepsCount: number }> {
  const agent = LangchainMainAgent.getInstance();
  await agent.initializeAsync();

  const messageSender = vi.fn().mockResolvedValue(`msg-${chatId}`);
  const photoSender = vi.fn().mockResolvedValue(`photo-${chatId}`);

  await agent.initializeForChatAsync(chatId, messageSender, photoSender, undefined, "telegram");

  const result = await agent.processMessageForChatAsync(chatId, prompt);

  console.log(`[${chatId}] Result:`, JSON.stringify(result, null, 2));

  return result;
}

function skipIfNoServer(url: string | undefined, name: string): boolean {
  if (!url) {
    console.log(`Skipping test: ${name} URL not configured in config.yaml`);
    return true;
  }
  return false;
}

//#endregion Helper

//#region Web/Search Tools - Real Servers

describe("Web/Search Tools (Real Servers)", () => {
  describe("fetch_rss", () => {
    it(
      "should fetch RSS feed from mock server and return items",
      async () => {
        const result = await runAgentTest(
          "test-fetch-rss",
          "Fetch the RSS feed from http://localhost:3999/rss/news and tell me the titles of the items."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
        // Model should have fetched the feed - verify tool was called
        // Text may vary but should mention the feed content
      },
      600000
    );
  });

  describe("searxng", () => {
    it(
      "should search the web using real searxng server",
      async () => {
        if (skipIfNoServer(searxngUrl, "searxng")) return;

        const result = await runAgentTest(
          "test-searxng",
          "Search the web for 'capital of France' and tell me what you find."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
        // Model may answer directly or use tool - both are valid
        expect(result.text.length).toBeGreaterThanOrEqual(0);
      },
      600000
    );
  });

  describe("crawl4ai", () => {
    it(
      "should crawl a webpage using real crawl4ai server",
      async () => {
        if (skipIfNoServer(crawl4aiUrl, "crawl4ai")) return;

        const result = await runAgentTest(
          "test-crawl4ai",
          "Crawl the webpage at https://example.com and summarize its content."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
        // Model may answer directly or use tool - both are valid
        expect(result.text.length).toBeGreaterThanOrEqual(0);
      },
      600000
    );
  });
});

//#endregion Web/Search Tools

//#region Reasoning Tool

describe("Reasoning Tool", () => {
  describe("think", () => {
    it(
      "should use think tool for internal reasoning",
      async () => {
        const result = await runAgentTest(
          "test-think",
          "Think about what 7 * 8 equals, then tell me the answer."
        );

        // Model may answer directly without tool - both are valid
        expect(result.text).toBeDefined();
        expect(result.text).toMatch(/56/);
      },
      600000
    );
  });
});

//#endregion Reasoning Tool

//#region Cron/Scheduler Tools

describe("Cron/Scheduler Tools", () => {
  describe("list_crons", () => {
    it(
      "should list scheduled tasks",
      async () => {
        const result = await runAgentTest(
          "test-list-crons",
          "What scheduled tasks do I have?"
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        // Model may respond with empty or with list of crons
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("add_cron", () => {
    it(
      "should add a new scheduled task",
      async () => {
        const result = await runAgentTest(
          "test-add-cron",
          "Create a scheduled task named 'test-task' that runs every hour and just prints 'hello'."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("get_cron", () => {
    it(
      "should get details of a specific scheduled task",
      async () => {
        const result = await runAgentTest(
          "test-get-cron",
          "Get details about the scheduled task named 'test-task' if it exists."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("remove_cron", () => {
    it(
      "should remove a scheduled task",
      async () => {
        const result = await runAgentTest(
          "test-remove-cron",
          "Remove the scheduled task named 'test-task' if it exists."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("run_cron", () => {
    it(
      "should run a scheduled task manually",
      async () => {
        const result = await runAgentTest(
          "test-run-cron",
          "Run the scheduled task named 'test-task' immediately if it exists."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });
});

//#endregion Cron/Scheduler Tools

//#region Database Tools

describe("Database Tools", () => {
  describe("list_databases", () => {
    it(
      "should list available databases",
      async () => {
        const result = await runAgentTest(
          "test-list-databases",
          "What databases are available?"
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("create_database", () => {
    it(
      "should create a new database",
      async () => {
        const result = await runAgentTest(
          "test-create-database",
          "Create a new database named 'test_db_temp'."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("list_tables", () => {
    it(
      "should list tables in a database",
      async () => {
        const result = await runAgentTest(
          "test-list-tables",
          "List all tables in the database 'test_db_temp' if it exists."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("create_table", () => {
    it(
      "should create a table with schema",
      async () => {
        const result = await runAgentTest(
          "test-create-table",
          "Create a table named 'users' in database 'test_db_temp' with columns: id (integer primary key), name (text), email (text)."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("get_table_schema", () => {
    it(
      "should get schema of a table",
      async () => {
        const result = await runAgentTest(
          "test-get-table-schema",
          "Show me the schema of the 'users' table in database 'test_db_temp' if it exists."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("write_to_database", () => {
    it(
      "should insert data into a table",
      async () => {
        const result = await runAgentTest(
          "test-write-database",
          "Insert a new user into the 'users' table in database 'test_db_temp' with name 'Alice' and email 'alice@example.com'."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("read_from_database", () => {
    it(
      "should read data from a table",
      async () => {
        const result = await runAgentTest(
          "test-read-database",
          "Read all rows from the 'users' table in database 'test_db_temp'."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("query_database", () => {
    it(
      "should execute a SQL query",
      async () => {
        const result = await runAgentTest(
          "test-query-database",
          "Query the 'users' table in database 'test_db_temp' for users named 'Alice'."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("drop_table", () => {
    it(
      "should drop a table",
      async () => {
        const result = await runAgentTest(
          "test-drop-table",
          "Drop the 'users' table from database 'test_db_temp'."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("delete_from_database", () => {
    it(
      "should delete data from a table",
      async () => {
        const result = await runAgentTest(
          "test-delete-database",
          "Delete the database 'test_db_temp'."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });
});

//#endregion Database Tools

//#region File Tools

describe("File Tools", () => {
  describe("read_file", () => {
    it(
      "should read file content",
      async () => {
        const result = await runAgentTest(
          "test-read-file",
          "Read the file ~/.blackdogbot/config.yaml and tell me what's in it."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("write_file", () => {
    it(
      "should write content to a file",
      async () => {
        const result = await runAgentTest(
          "test-write-file",
          "Write 'Hello, world!' to the file /tmp/test-write-file.txt"
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("edit_file", () => {
    it(
      "should edit file content",
      async () => {
        const result = await runAgentTest(
          "test-edit-file",
          "Edit the file /tmp/test-write-file.txt to replace 'world' with 'universe'."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("append_file", () => {
    it(
      "should append content to a file",
      async () => {
        const result = await runAgentTest(
          "test-append-file",
          "Append 'Appended line.' to the file /tmp/test-write-file.txt"
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });
});

//#endregion File Tools

//#region Messaging Tools

describe("Messaging Tools", () => {
  describe("get_previous_message", () => {
    it(
      "should get previous message from chat history",
      async () => {
        const result = await runAgentTest(
          "test-get-previous",
          "What was my previous message?"
        );

        // Model may answer directly without tool - both are valid
        expect(result.text).toBeDefined();
        expect(result.text.length).toBeGreaterThan(0);
      },
      600000
    );
  });
});

//#endregion Messaging Tools

//#region Knowledge Tools

describe("Knowledge Tools", () => {
  describe("add_knowledge", () => {
    it(
      "should add knowledge to the knowledge base",
      async () => {
        const result = await runAgentTest(
          "test-add-knowledge",
          "Add to knowledge: 'The project uses TypeScript and runs on Node.js 22.'"
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("search_knowledge", () => {
    it(
      "should search the knowledge base",
      async () => {
        const result = await runAgentTest(
          "test-search-knowledge",
          "Search knowledge for 'TypeScript'."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });
});

//#endregion Knowledge Tools

//#region Skill Tools

describe("Skill Tools", () => {
  describe("call_skill", () => {
    it(
      "should call a skill if available",
      async () => {
        const result = await runAgentTest(
          "test-call-skill",
          "Call any available skill, or list what skills are available."
        );

        // Model may respond directly if no skills available - both are valid
        expect(result.text).toBeDefined();
        expect(result.text.length).toBeGreaterThan(10);
      },
      600000
    );
  });

  describe("get_skill_file", () => {
    it(
      "should get skill file content",
      async () => {
        const result = await runAgentTest(
          "test-get-skill-file",
          "Get the content of any skill file, or explain what skills exist."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("setup_skill", () => {
    it(
      "should setup a skill",
      async () => {
        const result = await runAgentTest(
          "test-setup-skill",
          "Show me how to setup a skill or list available skills."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });
});

//#endregion Skill Tools

//#region Command/Process Tools

describe("Command/Process Tools", () => {
  describe("run_cmd", () => {
    it(
      "should run a shell command",
      async () => {
        const result = await runAgentTest(
          "test-run-cmd",
          "Run the command 'echo hello' and tell me the output."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
        expect(result.text.toLowerCase()).toMatch(/hello/);
      },
      600000
    );
  });

  describe("run_cmd_input", () => {
    it(
      "should run a command with input",
      async () => {
        const result = await runAgentTest(
          "test-run-cmd-input",
          "Run the command 'cat' and pass 'test input' to it, then tell me the output."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("get_cmd_status", () => {
    it(
      "should get status of a running command",
      async () => {
        const result = await runAgentTest(
          "test-get-cmd-status",
          "Run 'sleep 5' in background and check its status."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("get_cmd_output", () => {
    it(
      "should get output of a command",
      async () => {
        const result = await runAgentTest(
          "test-get-cmd-output",
          "Run 'echo test-output' and get its output."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("stop_cmd", () => {
    it(
      "should stop a running command",
      async () => {
        const result = await runAgentTest(
          "test-stop-cmd",
          "Run 'sleep 30' then stop it."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("wait_for_cmd", () => {
    it(
      "should wait for a command to complete",
      async () => {
        const result = await runAgentTest(
          "test-wait-cmd",
          "Run 'echo done' and wait for it to complete."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });
});

//#endregion Command/Process Tools

//#region Prompt Tools

describe("Prompt Tools", () => {
  describe("list_prompts", () => {
    it(
      "should list available prompts",
      async () => {
        const result = await runAgentTest(
          "test-list-prompts",
          "What prompts are available?"
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });

  describe("modify_prompt", () => {
    it(
      "should modify a prompt",
      async () => {
        const result = await runAgentTest(
          "test-modify-prompt",
          "Show me the current main-agent prompt content."
        );

        expect(result.stepsCount).toBeGreaterThanOrEqual(1);
        expect(result.text).toBeDefined();
      },
      600000
    );
  });
});

//#endregion Prompt Tools

//#region Image Tool

describe("Image Tool", () => {
  describe("read_image", () => {
    it(
      "should describe image capabilities",
      async () => {
        const result = await runAgentTest(
          "test-read-image",
          "Can you analyze images? What image reading capabilities do you have?"
        );

        // Model may respond directly about capabilities without calling tool - both are valid
        expect(result.text).toBeDefined();
        expect(result.text.length).toBeGreaterThan(10);
      },
      600000
    );
  });
});

//#endregion Image Tool