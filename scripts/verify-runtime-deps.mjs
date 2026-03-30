#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const checks = [
  {
    name: "better-sqlite3",
    args: ["-e", "require('better-sqlite3');"],
    hint:
      "Run: pnpm rebuild better-sqlite3\n" +
      "If rebuild fails, install build tools (gcc, make, python3) and run pnpm install again.",
  },
  {
    name: "sharp",
    args: ["-e", "require('sharp');"],
    hint:
      "Run: pnpm rebuild sharp\n" +
      "If this is an offline machine, ensure sharp's platform package is available during install.",
  },
  {
    name: "@huggingface/transformers (onnxruntime-node)",
    args: [
      "--input-type=module",
      "-e",
      "await import('@huggingface/transformers');",
    ],
    hint:
      "Run: pnpm rebuild onnxruntime-node\n" +
      "If it still fails with SIGILL/132, your CPU may not support instructions required by the prebuilt binary.",
  },
];

function runCheck(check) {
  const result = spawnSync(process.execPath, check.args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status === 0) {
    return null;
  }

  return {
    ...check,
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

for (const check of checks) {
  const failure = runCheck(check);

  if (!failure) {
    continue;
  }

  const statusText =
    failure.signal !== null
      ? `signal ${failure.signal}`
      : `exit code ${failure.status ?? "unknown"}`;
  const isIllegalInstruction =
    failure.signal === "SIGILL" || failure.status === 132;

  console.error("[preflight] Runtime dependency check failed.");
  console.error(`[preflight] Module: ${failure.name}`);
  console.error(`[preflight] Result: ${statusText}`);

  if (isIllegalInstruction) {
    console.error(
      "[preflight] Detected illegal instruction (SIGILL/132). This usually means an incompatible native binary for this CPU.",
    );
  }

  if (failure.stderr.trim().length > 0) {
    console.error("[preflight] stderr:");
    console.error(failure.stderr.trim());
  }

  if (failure.stdout.trim().length > 0) {
    console.error("[preflight] stdout:");
    console.error(failure.stdout.trim());
  }

  console.error("[preflight] Suggested fix:");
  console.error(failure.hint);
  process.exit(1);
}

console.log("[preflight] Runtime dependencies OK.");
