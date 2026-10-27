#!/usr/bin/env node
// Local Brain Interface CLI. Dedicated chat; normal production tool permissions.
// For harmless debugging only. No Telegram message is sent by the command itself.
// The chosen chat must already be registered in channels.yaml to receive tools.
import { io } from "socket.io-client";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
if (args.includes("--help") || args.length === 0) {
  console.log('Usage: node brain-interface/scripts/ask-agent.mjs [--max-steps N] [--timeout N] [--verbose] [--chat-id cli-NAME] "QUESTION"');
  process.exit(0);
}
const option = (name, fallback) => {
  const idx = args.indexOf(name);
  const value = idx < 0 ? fallback : Number(args[idx + 1]);
  if (!Number.isInteger(value) || value <= 0 || value > 7200) throw new Error("Invalid " + name);
  if (idx >= 0) args.splice(idx, 2);
  return value;
};
const maxSteps = option("--max-steps", 20);
const timeout = option("--timeout", 180);
const chatIdFlag = args.indexOf("--chat-id");
let chatId = "cli-debug-" + randomUUID();
if (chatIdFlag >= 0) {
  const requested = args[chatIdFlag + 1] || "";
  if (!/^cli-[A-Za-z0-9_-]{1,96}$/.test(requested)) throw new Error("--chat-id must start with cli- and be alphanumeric with hyphens/underscores");
  chatId = requested;
  args.splice(chatIdFlag, 2);
}
const verbose = args.includes("--verbose");
if (verbose) args.splice(args.indexOf("--verbose"), 1);
const question = args.join(" ").trim();
if (!question || question.startsWith("--")) throw new Error("A question is required");
const token = (await readFile(path.join(os.homedir(), ".blackdogbot", "brain-interface.token"), "utf8")).trim();
const socket = io("http://127.0.0.1:3001", {
  auth: { token }, transports: ["websocket"], timeout: 5000, reconnection: false, autoConnect: false,
});
const cmd = (type, extra = {}) => new Promise((resolve, reject) => {
  socket.emit("command", { type, chatId, ...extra }, (response) =>
    response?.success ? resolve(response.data) : reject(new Error(response?.error || type + " failed")));
});
let done = false;
let stopping = false;
const stop = async (reason) => {
  if (done || stopping) return;
  stopping = true;
  console.error("Stopping test: " + reason);
  // A queued request can wait behind an active chat; bound shutdown.
  setTimeout(() => { console.error("CLI timed out after stop; exiting."); process.exit(124); }, 5000).unref();
  try { await cmd("stop"); } catch (e) { console.error("Stop:", e.message); }
};
socket.on("event", (event) => {
  if (event?.data?.chatId !== chatId) return;
  if (event.type === "tool_called") {
    const { stepNumber, toolName, input } = event.data;
    console.log("Step", stepNumber, toolName);
    if (verbose && toolName === "run_code") console.log("  ", String(input?.code || "").slice(0, 750));
    if (stepNumber >= maxSteps) void stop("step limit " + maxSteps);
  }
  if (verbose && event.type === "tool_result" && event.data.toolName === "run_code") {
    console.log("  result:", JSON.stringify(event.data.output).slice(0, 750));
  }
});
const timer = setTimeout(() => void stop("timeout " + timeout + "s"), timeout * 1000);
try {
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
    socket.connect();
  });
  console.error("Isolated test chat", chatId, "- max steps:", maxSteps);
  await cmd("start_conversation");
  const result = await cmd("send_message", { message: question });
  done = true;
  console.log("\n=== Agent response ===\n" + (result?.text || "(empty)"));
  console.log("Steps:", result?.stepsCount);
  if (stopping) process.exitCode = 2;
} catch (error) {
  console.error("Agent CLI:", error.message);
  process.exitCode = 1;
} finally {
  done = true;
  clearTimeout(timer);
  socket.disconnect();
}