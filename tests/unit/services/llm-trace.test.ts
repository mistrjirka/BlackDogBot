import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  appendLlmTraceRecordAsync,
  resolveLlmTraceFilePath,
  type ILlmTraceRecord,
} from "../../../src/services/ai-provider/llm-trace.js";

//#region Helpers

const _record: ILlmTraceRecord = {
  ts: "2026-09-13T10:00:00.000Z",
  provider: "openai-compatible",
  url: "http://localhost:2345/v1/chat/completions",
  method: "POST",
  status: 200,
  requestBody: { model: "test", messages: [] },
  response: '{"ok":true}',
  responseTruncated: false,
};

//#endregion Helpers

describe("resolveLlmTraceFilePath", () => {
  it("returns null when the env var is unset or blank", () => {
    expect(resolveLlmTraceFilePath({})).toBeNull();
    expect(resolveLlmTraceFilePath({ BLACKDOG_LOG_LLM: "" })).toBeNull();
    expect(resolveLlmTraceFilePath({ BLACKDOG_LOG_LLM: "   " })).toBeNull();
  });

  it("returns the value as an explicit file path", () => {
    const explicit = "/tmp/custom/llm-trace.jsonl";
    expect(resolveLlmTraceFilePath({ BLACKDOG_LOG_LLM: explicit })).toBe(explicit);
  });

  it("resolves to the default logs path for true/1/on", () => {
    const expected: string = path.join(os.homedir(), ".blackdogbot", "logs", "llm-trace.jsonl");
    for (const value of ["true", "1", "on"]) {
      expect(resolveLlmTraceFilePath({ BLACKDOG_LOG_LLM: value })).toBe(expected);
    }
  });
});

describe("appendLlmTraceRecordAsync", () => {
  it("writes nothing when tracing is disabled", async () => {
    const tempDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "llm-trace-"));
    const file: string = path.join(tempDir, "trace.jsonl");

    try {
      const result: string | null = await appendLlmTraceRecordAsync(_record, {});
      expect(result).toBeNull();
      await expect(fs.access(file)).rejects.toThrow();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("appends one JSONL line per record and creates missing directories", async () => {
    const tempDir: string = await fs.mkdtemp(path.join(os.tmpdir(), "llm-trace-"));
    const file: string = path.join(tempDir, "nested", "trace.jsonl");

    try {
      const env: NodeJS.ProcessEnv = { BLACKDOG_LOG_LLM: file };
      const written: string | null = await appendLlmTraceRecordAsync(_record, env);
      expect(written).toBe(file);

      await appendLlmTraceRecordAsync(
        { ..._record, status: 400, response: "error payload", responseTruncated: false },
        env,
      );

      const content: string = await fs.readFile(file, "utf-8");
      const lines: Array<Record<string, unknown>> = content
        .trim()
        .split("\n")
        .map((line: string): Record<string, unknown> => JSON.parse(line));

      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual(_record);
      expect(lines[1].status).toBe(400);
      expect(lines[1].response).toBe("error payload");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
