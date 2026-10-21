import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createBaseToolSet } from "../../../src/agent/tool-assembly.js";
import { FileReadTracker } from "../../../src/utils/file-tools-helper.js";
import {
  createSendFileTool,
  MAX_SEND_FILE_BYTES,
} from "../../../src/tools/send-file.tool.js";

const toolOptions = { toolCallId: "test-call", messages: [] };

let tempDir: string;
let originalHome: string | undefined;
let workspaceDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "blackdogbot-send-file-test-"));
  originalHome = process.env.HOME;
  process.env.HOME = tempDir;

  workspaceDir = path.join(tempDir, ".blackdogbot", "workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();

  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("send_file tool", () => {
  it("is registered only when a file sender is available", () => {
    const messageSender = async (): Promise<string | null> => null;
    const fileSender = async (): Promise<string | null> => null;

    const withoutFileSender = createBaseToolSet(messageSender, new FileReadTracker());
    const withFileSender = createBaseToolSet(
      messageSender,
      new FileReadTracker(),
      fileSender,
    );

    expect(withoutFileSender.send_file).toBeUndefined();
    expect(withFileSender.send_file).toBeDefined();
  });

  it("sends a workspace file and returns its metadata", async () => {
    const fileSender = vi.fn(
      async (_fileBuffer: Buffer, _fileName: string, _caption: string | null): Promise<string | null> =>
        "file-message-1",
    );
    const sendFileTool = createSendFileTool(fileSender);
    const filePath = path.join(workspaceDir, "reports", "q1.txt");

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "quarterly report", "utf-8");

    if (!sendFileTool.execute) {
      throw new Error("send_file has no execute function");
    }

    const result = await sendFileTool.execute(
      { filePath: "reports/q1.txt", caption: "Q1 report" },
      toolOptions,
    );

    expect(result).toEqual({
      sent: true,
      messageId: "file-message-1",
      fileName: "q1.txt",
      sizeBytes: Buffer.byteLength("quarterly report"),
    });
    expect(fileSender).toHaveBeenCalledWith(
      Buffer.from("quarterly report"),
      "q1.txt",
      "Q1 report",
    );
  });

  it("passes null when no caption is provided", async () => {
    const fileSender = vi.fn(
      async (_fileBuffer: Buffer, _fileName: string, _caption: string | null): Promise<string | null> =>
        "file-message-2",
    );
    const sendFileTool = createSendFileTool(fileSender);

    await fs.writeFile(path.join(workspaceDir, "notes.txt"), "notes", "utf-8");

    if (!sendFileTool.execute) {
      throw new Error("send_file has no execute function");
    }

    await sendFileTool.execute({ filePath: "notes.txt" }, toolOptions);

    expect(fileSender).toHaveBeenCalledWith(Buffer.from("notes"), "notes.txt", null);
  });

  it("rejects files outside the workspace and uploads directories", async () => {
    const fileSender = vi.fn();
    const sendFileTool = createSendFileTool(fileSender);
    const outsidePath = path.join(tempDir, "outside.txt");

    await fs.writeFile(outsidePath, "outside", "utf-8");

    if (!sendFileTool.execute) {
      throw new Error("send_file has no execute function");
    }

    const result = await sendFileTool.execute(
      { filePath: outsidePath },
      toolOptions,
    );

    expect(result.sent).toBe(false);
    expect(result.error).toContain("workspace or uploads directory");
    expect(fileSender).not.toHaveBeenCalled();
  });

  it("rejects symlinks that resolve outside the allowed directories", async () => {
    const fileSender = vi.fn();
    const sendFileTool = createSendFileTool(fileSender);
    const outsidePath = path.join(tempDir, "secret.txt");
    const linkPath = path.join(workspaceDir, "secret-link.txt");

    await fs.writeFile(outsidePath, "secret", "utf-8");
    await fs.symlink(outsidePath, linkPath);

    if (!sendFileTool.execute) {
      throw new Error("send_file has no execute function");
    }

    const result = await sendFileTool.execute(
      { filePath: "secret-link.txt" },
      toolOptions,
    );

    expect(result.sent).toBe(false);
    expect(result.error).toContain("workspace or uploads directory");
    expect(fileSender).not.toHaveBeenCalled();
  });

  it("rejects directories", async () => {
    const fileSender = vi.fn();
    const sendFileTool = createSendFileTool(fileSender);

    await fs.mkdir(path.join(workspaceDir, "folder"));

    if (!sendFileTool.execute) {
      throw new Error("send_file has no execute function");
    }

    const result = await sendFileTool.execute(
      { filePath: "folder" },
      toolOptions,
    );

    expect(result.sent).toBe(false);
    expect(result.error).toContain("not a regular file");
    expect(fileSender).not.toHaveBeenCalled();
  });

  it("rejects files larger than the size limit before reading them", async () => {
    const fileSender = vi.fn();
    const sendFileTool = createSendFileTool(fileSender);
    const largeFilePath = path.join(workspaceDir, "large.bin");
    const handle = await fs.open(largeFilePath, "w");

    await handle.truncate(MAX_SEND_FILE_BYTES + 1);
    await handle.close();

    if (!sendFileTool.execute) {
      throw new Error("send_file has no execute function");
    }

    const result = await sendFileTool.execute(
      { filePath: "large.bin" },
      toolOptions,
    );

    expect(result.sent).toBe(false);
    expect(result.error).toContain("too large");
    expect(fileSender).not.toHaveBeenCalled();
  });

  it("returns an error when the sender throws", async () => {
    const fileSender = vi.fn(async (): Promise<string | null> => {
      throw new Error("Telegram upload failed");
    });
    const sendFileTool = createSendFileTool(fileSender);

    await fs.writeFile(path.join(workspaceDir, "report.txt"), "report", "utf-8");

    if (!sendFileTool.execute) {
      throw new Error("send_file has no execute function");
    }

    const result = await sendFileTool.execute(
      { filePath: "report.txt" },
      toolOptions,
    );

    expect(result.sent).toBe(false);
    expect(result.error).toContain("Telegram upload failed");
  });
});
