import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { FileReadTracker, resolveFilePath } from "../../../src/utils/file-tools-helper.js";
import { createReadFileTool } from "../../../src/tools/read-file.tool.js";
import { createWriteFileTool } from "../../../src/tools/write-file.tool.js";
import { appendFileTool } from "../../../src/tools/append-file.tool.js";
import { editFileTool } from "../../../src/tools/edit-file.tool.js";
import { LoggerService } from "../../../src/services/logger.service.js";
import { getWorkspaceDir } from "../../../src/utils/paths.js";

//#region Types

interface IReadFileResult {
  success: boolean;
  content: string | undefined;
  message: string;
}

interface IWriteFileResult {
  success: boolean;
  message: string;
}

interface IAppendFileResult {
  success: boolean;
  message: string;
}

interface IEditFileResult {
  success: boolean;
  replacements: number | undefined;
  message: string;
}

//#endregion Types

//#region Helpers

let tempDir: string;
let originalHome: string;

const TOOL_OPTIONS = { toolCallId: "tc1", messages: [] as never[], abortSignal: undefined as unknown as AbortSignal };

async function setupTempHomeAsync(): Promise<void> {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "betterclaw-file-tools-"));
  originalHome = process.env.HOME ?? os.homedir();
  process.env.HOME = tempDir;

  // Create workspace directory
  const workspaceDir: string = getWorkspaceDir();

  await fs.mkdir(workspaceDir, { recursive: true });
}

async function teardownTempHomeAsync(): Promise<void> {
  process.env.HOME = originalHome;
  await fs.rm(tempDir, { recursive: true, force: true });
}

//#endregion Helpers

//#region FileReadTracker Tests

describe("FileReadTracker", () => {
  it("should track read paths", () => {
    const tracker: FileReadTracker = new FileReadTracker();

    expect(tracker.hasBeenRead("/some/path.txt")).toBe(false);

    tracker.markRead("/some/path.txt");

    expect(tracker.hasBeenRead("/some/path.txt")).toBe(true);
    expect(tracker.hasBeenRead("/other/path.txt")).toBe(false);
  });

  it("should handle multiple paths independently", () => {
    const tracker: FileReadTracker = new FileReadTracker();

    tracker.markRead("/a.txt");
    tracker.markRead("/b.txt");

    expect(tracker.hasBeenRead("/a.txt")).toBe(true);
    expect(tracker.hasBeenRead("/b.txt")).toBe(true);
    expect(tracker.hasBeenRead("/c.txt")).toBe(false);
  });
});

//#endregion FileReadTracker Tests

//#region resolveFilePath Tests

describe("resolveFilePath", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
  });

  afterEach(async () => {
    await teardownTempHomeAsync();
  });

  it("should resolve a plain filename to the workspace directory", () => {
    const resolved: string = resolveFilePath("notes.txt");

    expect(resolved).toBe(path.join(getWorkspaceDir(), "notes.txt"));
  });

  it("should resolve a relative path with subdirectories to the workspace directory", () => {
    const resolved: string = resolveFilePath("subdir/file.txt");

    expect(resolved).toBe(path.join(getWorkspaceDir(), "subdir", "file.txt"));
  });

  it("should keep absolute paths as-is", () => {
    const resolved: string = resolveFilePath("/tmp/absolute.txt");

    expect(resolved).toBe("/tmp/absolute.txt");
  });

  it("should expand tilde to home directory", () => {
    const resolved: string = resolveFilePath("~/documents/file.txt");

    expect(resolved).toBe(path.join(os.homedir(), "documents", "file.txt"));
  });

  it("should throw on empty string", () => {
    expect(() => resolveFilePath("")).toThrow("File path cannot be empty.");
  });

  it("should throw on whitespace-only string", () => {
    expect(() => resolveFilePath("   ")).toThrow("File path cannot be empty.");
  });
});

//#endregion resolveFilePath Tests

//#region read_file Tool Tests

describe("read_file tool", () => {
  let tracker: FileReadTracker;
  let executeRead: (input: { filePath: string }) => Promise<IReadFileResult>;

  beforeEach(async () => {
    await setupTempHomeAsync();

    const loggerService: LoggerService = LoggerService.getInstance();

    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    tracker = new FileReadTracker();

    const readTool = createReadFileTool(tracker);

    executeRead = async (input: { filePath: string }): Promise<IReadFileResult> => {
      return await readTool.execute!(input, TOOL_OPTIONS) as IReadFileResult;
    };
  });

  afterEach(async () => {
    (LoggerService as unknown as { _instance: null })._instance = null;
    await teardownTempHomeAsync();
  });

  it("should read a file from the workspace directory using just a filename", async () => {
    // Arrange — create a file in the workspace
    const workspaceDir: string = getWorkspaceDir();
    const filePath: string = path.join(workspaceDir, "test.txt");

    await fs.writeFile(filePath, "hello world", "utf-8");

    // Act
    const result: IReadFileResult = await executeRead({ filePath: "test.txt" });

    // Assert
    expect(result.success).toBe(true);
    expect(result.content).toBe("hello world");
    expect(tracker.hasBeenRead(filePath)).toBe(true);
  });

  it("should read a file using an absolute path", async () => {
    // Arrange — create a file outside the workspace
    const filePath: string = path.join(tempDir, "outside.txt");

    await fs.writeFile(filePath, "outside content", "utf-8");

    // Act
    const result: IReadFileResult = await executeRead({ filePath });

    // Assert
    expect(result.success).toBe(true);
    expect(result.content).toBe("outside content");
    expect(tracker.hasBeenRead(filePath)).toBe(true);
  });

  it("should return error when file does not exist", async () => {
    // Act
    const result: IReadFileResult = await executeRead({ filePath: "nonexistent.txt" });

    // Assert
    expect(result.success).toBe(false);
    expect(result.content).toBeUndefined();
    expect(result.message).toMatch(/ENOENT|no such file/i);
  });
});

//#endregion read_file Tool Tests

//#region write_file Tool Tests

describe("write_file tool", () => {
  let tracker: FileReadTracker;
  let executeRead: (input: { filePath: string }) => Promise<IReadFileResult>;
  let executeWrite: (input: { filePath: string; content: string }) => Promise<IWriteFileResult>;

  beforeEach(async () => {
    await setupTempHomeAsync();

    const loggerService: LoggerService = LoggerService.getInstance();

    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    tracker = new FileReadTracker();

    const readTool = createReadFileTool(tracker);
    const writeTool = createWriteFileTool(tracker);

    executeRead = async (input: { filePath: string }): Promise<IReadFileResult> => {
      return await readTool.execute!(input, TOOL_OPTIONS) as IReadFileResult;
    };

    executeWrite = async (input: { filePath: string; content: string }): Promise<IWriteFileResult> => {
      return await writeTool.execute!(input, TOOL_OPTIONS) as IWriteFileResult;
    };
  });

  afterEach(async () => {
    (LoggerService as unknown as { _instance: null })._instance = null;
    await teardownTempHomeAsync();
  });

  it("should create a new file without requiring read first", async () => {
    // Act — write to a file that does not exist yet
    const result: IWriteFileResult = await executeWrite({ filePath: "new-file.txt", content: "new content" });

    // Assert
    expect(result.success).toBe(true);

    const written: string = await fs.readFile(path.join(getWorkspaceDir(), "new-file.txt"), "utf-8");

    expect(written).toBe("new content");
  });

  it("should reject overwriting an existing file that was not read first", async () => {
    // Arrange — create an existing file
    const filePath: string = path.join(getWorkspaceDir(), "existing.txt");

    await fs.writeFile(filePath, "original content", "utf-8");

    // Act — try to overwrite without reading first
    const result: IWriteFileResult = await executeWrite({ filePath: "existing.txt", content: "new content" });

    // Assert — should be rejected
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/must read the file/i);

    // Verify the original file is unchanged
    const content: string = await fs.readFile(filePath, "utf-8");

    expect(content).toBe("original content");
  });

  it("should allow overwriting an existing file after reading it first", async () => {
    // Arrange — create an existing file and read it first
    const filePath: string = path.join(getWorkspaceDir(), "existing.txt");

    await fs.writeFile(filePath, "original content", "utf-8");

    await executeRead({ filePath: "existing.txt" });

    // Act — now overwrite after reading
    const result: IWriteFileResult = await executeWrite({ filePath: "existing.txt", content: "updated content" });

    // Assert
    expect(result.success).toBe(true);

    const content: string = await fs.readFile(filePath, "utf-8");

    expect(content).toBe("updated content");
  });

  it("should allow subsequent writes without re-reading", async () => {
    // Arrange — create, read, then write once
    const filePath: string = path.join(getWorkspaceDir(), "multi.txt");

    await fs.writeFile(filePath, "v1", "utf-8");

    await executeRead({ filePath: "multi.txt" });
    await executeWrite({ filePath: "multi.txt", content: "v2" });

    // Act — write again without reading in between (should work because markRead persists)
    const result: IWriteFileResult = await executeWrite({ filePath: "multi.txt", content: "v3" });

    // Assert
    expect(result.success).toBe(true);

    const content: string = await fs.readFile(filePath, "utf-8");

    expect(content).toBe("v3");
  });
});

//#endregion write_file Tool Tests

//#region append_file Tool Tests

describe("append_file tool", () => {
  let executeAppend: (input: { filePath: string; content: string }) => Promise<IAppendFileResult>;

  beforeEach(async () => {
    await setupTempHomeAsync();

    const loggerService: LoggerService = LoggerService.getInstance();

    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    executeAppend = async (input: { filePath: string; content: string }): Promise<IAppendFileResult> => {
      return await appendFileTool.execute!(input, TOOL_OPTIONS) as IAppendFileResult;
    };
  });

  afterEach(async () => {
    (LoggerService as unknown as { _instance: null })._instance = null;
    await teardownTempHomeAsync();
  });

  it("should create a new file when appending to a nonexistent file", async () => {
    // Act
    const result: IAppendFileResult = await executeAppend({ filePath: "append-new.txt", content: "first line\n" });

    // Assert
    expect(result.success).toBe(true);

    const content: string = await fs.readFile(path.join(getWorkspaceDir(), "append-new.txt"), "utf-8");

    expect(content).toBe("first line\n");
  });

  it("should append to an existing file without requiring read first", async () => {
    // Arrange — create an existing file
    const filePath: string = path.join(getWorkspaceDir(), "append-existing.txt");

    await fs.writeFile(filePath, "line 1\n", "utf-8");

    // Act — append without reading first (should work)
    const result: IAppendFileResult = await executeAppend({ filePath: "append-existing.txt", content: "line 2\n" });

    // Assert
    expect(result.success).toBe(true);

    const content: string = await fs.readFile(filePath, "utf-8");

    expect(content).toBe("line 1\nline 2\n");
  });
});

//#endregion append_file Tool Tests

//#region edit_file Tool Tests

describe("edit_file tool", () => {
  let executeEdit: (input: { filePath: string; oldString: string; newString: string; replaceAll: boolean }) => Promise<IEditFileResult>;

  beforeEach(async () => {
    await setupTempHomeAsync();

    const loggerService: LoggerService = LoggerService.getInstance();

    await loggerService.initializeAsync("info", path.join(tempDir, "logs"));

    executeEdit = async (input: { filePath: string; oldString: string; newString: string; replaceAll: boolean }): Promise<IEditFileResult> => {
      return await editFileTool.execute!(input, TOOL_OPTIONS) as IEditFileResult;
    };
  });

  afterEach(async () => {
    (LoggerService as unknown as { _instance: null })._instance = null;
    await teardownTempHomeAsync();
  });

  it("should replace the first occurrence by default", async () => {
    // Arrange
    const filePath: string = path.join(getWorkspaceDir(), "edit-test.txt");

    await fs.writeFile(filePath, "foo bar foo baz", "utf-8");

    // Act
    const result: IEditFileResult = await executeEdit({
      filePath: "edit-test.txt", oldString: "foo", newString: "qux", replaceAll: false,
    });

    // Assert
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(1);

    const content: string = await fs.readFile(filePath, "utf-8");

    expect(content).toBe("qux bar foo baz");
  });

  it("should replace all occurrences when replaceAll is true", async () => {
    // Arrange
    const filePath: string = path.join(getWorkspaceDir(), "edit-all.txt");

    await fs.writeFile(filePath, "foo bar foo baz foo", "utf-8");

    // Act
    const result: IEditFileResult = await executeEdit({
      filePath: "edit-all.txt", oldString: "foo", newString: "qux", replaceAll: true,
    });

    // Assert
    expect(result.success).toBe(true);
    expect(result.replacements).toBe(3);

    const content: string = await fs.readFile(filePath, "utf-8");

    expect(content).toBe("qux bar qux baz qux");
  });

  it("should return error when oldString is not found", async () => {
    // Arrange
    const filePath: string = path.join(getWorkspaceDir(), "edit-notfound.txt");

    await fs.writeFile(filePath, "hello world", "utf-8");

    // Act
    const result: IEditFileResult = await executeEdit({
      filePath: "edit-notfound.txt", oldString: "nonexistent", newString: "replacement", replaceAll: false,
    });

    // Assert
    expect(result.success).toBe(false);
    expect(result.replacements).toBe(0);
    expect(result.message).toMatch(/not found/i);
  });

  it("should return error when file does not exist", async () => {
    // Act
    const result: IEditFileResult = await executeEdit({
      filePath: "nonexistent.txt", oldString: "foo", newString: "bar", replaceAll: false,
    });

    // Assert
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/ENOENT|no such file/i);
  });

  it("should not require reading the file first", async () => {
    // Arrange — create file, do NOT read it
    const filePath: string = path.join(getWorkspaceDir(), "edit-noread.txt");

    await fs.writeFile(filePath, "original text here", "utf-8");

    // Act — edit should succeed without prior read
    const result: IEditFileResult = await executeEdit({
      filePath: "edit-noread.txt", oldString: "original", newString: "modified", replaceAll: false,
    });

    // Assert
    expect(result.success).toBe(true);

    const content: string = await fs.readFile(filePath, "utf-8");

    expect(content).toBe("modified text here");
  });
});

//#endregion edit_file Tool Tests

//#region Workspace Directory Tests

describe("workspace directory", () => {
  beforeEach(async () => {
    await setupTempHomeAsync();
  });

  afterEach(async () => {
    await teardownTempHomeAsync();
  });

  it("should resolve to ~/.betterclaw/workspace", () => {
    const workspaceDir: string = getWorkspaceDir();

    expect(workspaceDir).toBe(path.join(os.homedir(), ".betterclaw", "workspace"));
  });
});

//#endregion Workspace Directory Tests
