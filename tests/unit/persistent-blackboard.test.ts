import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VariableStore } from "../../src/utils/variable-store.js";

const dir = path.join(os.tmpdir(), "bdb-blackboards-" + process.pid);
vi.mock("../../src/utils/paths.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/utils/paths.js")>();
  return { ...original, getSessionsDir: () => dir };
});

import { loadBlackboardAsync, scheduleBlackboardSave, flushBlackboardAsync } from "../../src/utils/variable-persistence.js";
import { createInspectVariableTool } from "../../src/tools/inspect-variable.tool.js";
import { createRunCodeTool } from "../../src/tools/run-code.tool.js";
import type { ToolExecutionOptions } from "ai";

const opts = {} as ToolExecutionOptions<never>;
const big = (n: number) => "A".repeat(n);
afterAll(async () => fs.rm(dir, { recursive: true, force: true }));

describe("persistent chat blackboards", () => {
  it("keeps names, values and monotonic counters across turns/restart", async () => {
    const first = await loadBlackboardAsync("chat-A");
    const captured = first.maybeCapture("read_file", big(4500)) as { variable: string };
    expect(captured.variable).toBe("read_file_1");
    await scheduleBlackboardSave("chat-A", first);
    const recovered = await loadBlackboardAsync("chat-A");
    expect(recovered.get("read_file_1")).toBe(big(4500));
    expect((recovered.maybeCapture("read_file", big(5500)) as { variable: string }).variable).toBe("read_file_2");
    await scheduleBlackboardSave("chat-A", recovered);
    const later = await loadBlackboardAsync("chat-A");
    expect(later.names()).toEqual(["read_file_1", "read_file_2"]);
  });

  it("isolates chat sessions even when variable names are identical", async () => {
    const b = await loadBlackboardAsync("chat-B");
    expect(b.names()).toEqual([]);
    b.maybeCapture("read_file", "B".repeat(4200));
    await scheduleBlackboardSave("chat-B", b);
    const a = await loadBlackboardAsync("chat-A");
    expect(a.get("read_file_1")).toBe(big(4500));
    expect((await loadBlackboardAsync("chat-B")).get("read_file_1")).toBe("B".repeat(4200));
  });

  it("serializes overlapping captures without leaving an older snapshot", async () => {
    const store = new VariableStore();
    const promises: Promise<void>[] = [];
    store.setOnChange(() => { promises.push(scheduleBlackboardSave("chat-C", store)); });
    store.maybeCapture("search", big(4400));
    store.maybeCapture("search", big(4700));
    await Promise.all(promises);
    await flushBlackboardAsync("chat-C");
    const loaded = await loadBlackboardAsync("chat-C");
    expect(loaded.names()).toEqual(["search_1", "search_2"]);
    expect(loaded.get("search_2")).toBe(big(4700));
  });

  it("maintains FIFO limits after restoration and supports /clear", async () => {
    const store = new VariableStore();
    for (let i = 0; i < 55; i++) store.maybeCapture("result", big(4100) + i);
    expect(store.names()).toHaveLength(50);
    const snapshot = store.snapshot();
    const restored = VariableStore.fromSnapshot(snapshot);
    expect(restored.names()).toEqual(store.names());
    const next = restored.maybeCapture("result", big(4101)) as { variable: string };
    expect(next.variable).toBe("result_56");
    expect(restored.names()).toHaveLength(50);
    restored.clear();
    expect(restored.names()).toEqual([]);
  });

  it("quarantines malformed snapshots instead of overwriting the only copy", async () => {
    const saved = new VariableStore();
    saved.maybeCapture("doc", "Q".repeat(4200));
    await scheduleBlackboardSave("chat-corrupt", saved);
    const folder = path.join(dir, "blackboards");
    const files = await fs.readdir(folder);
    // Find the test fixture by its stored value; filenames intentionally contain only hashes.
    const matches = await Promise.all(files.map(async (name) => ({ name,
      content: await fs.readFile(path.join(folder, name), "utf8") })));
    const target = matches.find(({ content }) => content.includes("Q".repeat(100)));
    expect(target).toBeDefined();
    const location = path.join(folder, target!.name);
    await fs.writeFile(location, "{broken-json", "utf8");
    await expect(loadBlackboardAsync("chat-corrupt")).rejects.toThrow();
    const after = await fs.readdir(folder);
    expect(after.some(name => name.startsWith(target!.name + ".corrupt-"))).toBe(true);
    const reloaded = await loadBlackboardAsync("chat-corrupt");
    expect(reloaded.names()).toEqual([]);
  });

  it("persists /clear without accidentally reusing former variable names", async () => {
    const store = new VariableStore();
    store.maybeCapture("web", "X".repeat(4300));
    store.setOnChange(() => { void scheduleBlackboardSave("chat-clear", store); });
    store.clear();
    await flushBlackboardAsync("chat-clear");
    expect((await loadBlackboardAsync("chat-clear")).names()).toEqual([]);
  });

  it("lists metadata without exposing raw values or requiring a name", async () => {
    const store = new VariableStore();
    store.maybeCapture("page", "PRIVATE_SECRET_VALUE".repeat(280));
    const inspect = createInspectVariableTool(() => store);
    const inventory = await inspect.execute!({ offset: 0, maxChars: 100 }, opts);
    expect(inventory).toMatchObject({ count: 1 });
    expect(JSON.stringify(inventory)).not.toContain("PRIVATE_SECRET_VALUE");
    const savedName = store.names()[0];
    const slice = await inspect.execute!({ name: savedName, offset: 0, maxChars: 12 }, opts);
    expect(slice).toMatchObject({ content: "PRIVATE_SECR" });
  });

  it("passes only variables referenced in run_code to the worker", async () => {
    const store = new VariableStore();
    store.maybeCapture("read_file", "A".repeat(4500));
    store.maybeCapture("read_file", "B".repeat(4500));
    const spy = vi.spyOn(store, "get");
    const result = await createRunCodeTool(() => store).execute!({
      code: "print(read_file_1.slice(0,3));",
    }, opts);
    expect(result).toMatchObject({ ok: true, display: "AAA" });
    expect(spy).toHaveBeenCalledWith("read_file_1");
    expect(spy).not.toHaveBeenCalledWith("read_file_2");
  });
});
