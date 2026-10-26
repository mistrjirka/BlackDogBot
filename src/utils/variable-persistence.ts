import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getSessionsDir } from "./paths.js";
import { VariableStore, type IVariableStoreSnapshot } from "./variable-store.js";

/** Persistent chat-scoped blackboard, outside messages/system prompt. */
function fileFor(chatId: string): string {
  const key = crypto.createHash("sha256").update(chatId).digest("hex");
  return path.join(getSessionsDir(), "blackboards", key + ".json");
}

/** Each path has a write queue. Snapshots are copied immediately; writes use atomic rename. */
const pending = new Map<string, Promise<void>>();
let serial = 0;

export function scheduleBlackboardSave(chatId: string, store: VariableStore): Promise<void> {
  const filename = fileFor(chatId);
  const data = JSON.stringify(store.snapshot());
  const previous = pending.get(filename) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temp = filename + "." + process.pid + "." + (++serial) + ".tmp";
    try {
      await fs.writeFile(temp, data, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temp, filename);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  });
  pending.set(filename, next);
  void next.finally(() => {
    if (pending.get(filename) === next) pending.delete(filename);
  }).catch(() => {});
  return next;
}

export async function flushBlackboardAsync(chatId: string): Promise<void> {
  await pending.get(fileFor(chatId));
}

export async function loadBlackboardAsync(chatId: string): Promise<VariableStore> {
  await flushBlackboardAsync(chatId);
  try {
    const raw = await fs.readFile(fileFor(chatId), "utf8");
    if (Buffer.byteLength(raw, "utf8") > 10 * 1024 * 1024) {
      throw new Error("Blackboard snapshot is over storage limit");
    }
    const data: IVariableStoreSnapshot = JSON.parse(raw) as IVariableStoreSnapshot;
    if (data.version !== 1 || !Array.isArray(data.variables)) {
      throw new Error("Unrecognized blackboard snapshot format");
    }
    return VariableStore.fromSnapshot(data);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return new VariableStore();
    }
    // Quarantine bad data so later activity cannot silently overwrite it.
    const backup = fileFor(chatId) + ".corrupt-" + Date.now();
    try { await fs.rename(fileFor(chatId), backup); } catch { /* preserve original if rename fails */ }
    throw error;
  }
}
