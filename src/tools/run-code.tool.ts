import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { analyze } from "eslint-scope";
import { tool } from "ai";
import { z } from "zod";
import type { VariableStore } from "../utils/variable-store.js";

const MAX_CODE_CHARS = 4000;
const MAX_MS = 5000;
const WORKER = fileURLToPath(new URL("../workers/run-code-worker.cjs", import.meta.url));
// Node 26+ permission mode denies filesystem writes, child processes and network
// by default. Permit reading only the worker source itself.
const NODE_MAJOR = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
const BUILTINS = new Set(["print", "console", "Object", "Array", "JSON", "Math", "String", "Number", "Boolean", "Promise", "RegExp", "Date", "Set", "Map", "Infinity", "NaN", "undefined", "isNaN", "parseInt", "parseFloat"]);
const BANNED_MEMBER_NAMES = new Set(["constructor", "__proto__", "prototype"]);

type WorkerReply =
  | { ok: true; returned: boolean; value?: unknown; display: string; truncated: boolean }
  | { ok: false; category: string; message: string };

/** Parse and check identifiers before spawning the worker. Tool calls are never available in code. */
function checkCode(code: string, available: string[]): { category: string; message: string } | null {
  try {
    const ast = acorn.parse(`function __run__(){\n${code}\n}`, {
      ecmaVersion: "latest", sourceType: "script", locations: true, ranges: true,
    });
    let unsafe: string | null = null;
    walk.full(ast, (node) => {
      if (node.type === "ImportExpression" || node.type === "ThisExpression" || node.type === "Super" || node.type === "WithStatement") {
        unsafe = `Unsupported expression: ${node.type}`;
      }
      if (node.type === "MemberExpression") {
        const member = node as typeof node & { computed: boolean; property: { name?: string; value?: unknown } };
        const prop = member.computed ? member.property.value : member.property.name;
        if (typeof prop === "string" && BANNED_MEMBER_NAMES.has(prop)) unsafe = `Forbidden member: ${prop}`;
      }
    });
    if (unsafe) return { category: "validation", message: unsafe };
    const scope = analyze(ast as Parameters<typeof analyze>[0], { ecmaVersion: 2022, sourceType: "script" });
    const names = new Set(available);
    const unknown = [...new Set((scope.globalScope?.through ?? []).map((ref) => ref.identifier.name)
      .filter((name) => !names.has(name) && !BUILTINS.has(name)))];
    if (unknown.length) return { category: "unknown_variable", message: `Unknown identifiers: ${unknown.join(", ")}. Available variables: ${available.join(", ") || "(none)"}` };
    return null;
  } catch (error) {
    const e = error as { message?: string; loc?: { line: number; column: number } };
    return { category: "syntax", message: `${e.loc ? `${Math.max(1, e.loc.line - 1)}:${e.loc.column} ` : ""}${e.message ?? String(error)}` };
  }
}

function runWorker(code: string, variables: Record<string, unknown>): Promise<WorkerReply> {
  return new Promise((resolve) => {
    const worker = fork(WORKER, [], {
      execArgv: ["--max-old-space-size=128", ...(NODE_MAJOR >= 26 ? ["--permission", `--allow-fs-read=${WORKER}`] : [])],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let settled = false;
    const done = (result: WorkerReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.kill("SIGTERM");
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, category: "timeout", message: "Code exceeded the 5-second execution limit." }), MAX_MS);
    worker.once("message", (message: WorkerReply) => done(message));
    worker.once("error", (error) => done({ ok: false, category: "validation", message: error.message }));
    worker.once("exit", (exitCode, signal) => done({ ok: false, category: "memory", message: `Worker exited (${exitCode ?? signal}).` }));
    worker.send({ code, variables }, (err) => { if (err) done({ ok: false, category: "validation", message: err.message }); });
  });
}

/** Data-only transformation; never exposes shell, tools, network, or files to code. */
export function createRunCodeTool(getStore: () => VariableStore | null) {
  let failures = 0;
  let lastStore: VariableStore | null = null;
  return tool({
    description: "Transform stored blackboard values with synchronous JavaScript (max 4000 characters). Tool calls, shell commands, network and files are NOT available. Variables are injected as read-only names shown in stored-result stubs. Use print(value) or console.log(value) for bounded inspection; return a JSON-serializable value to create a new code_<n> variable (≤1 MiB). Data is passed to write_file, add_knowledge, or write_table_* by variable reference. Limit: 5 seconds, 128 MiB. If repeated errors occur, fall back to direct tools.",
    inputSchema: z.object({ code: z.string().min(1).max(MAX_CODE_CHARS).describe("JavaScript function body. Example: print(mcp_searxng_search_1.slice(0,2)); return mcp_searxng_search_1.filter(x => x.title);") }),
    execute: async ({ code }: { code: string }) => {
      const store = getStore();
      if (store !== lastStore) { failures = 0; lastStore = store; }
      if (!store) return { ok: false, category: "validation", message: "No active blackboard." };
      if (failures >= 3) return { ok: false, category: "validation", message: "run_code retry limit reached. Fall back to direct tools." };
      const names = store.names();
      const issue = checkCode(code, names);
      if (issue) { failures++; return { ok: false, ...issue, availableVariables: names, attempt: failures, maxAttempts: 3 }; }
      const variables: Record<string, unknown> = {};
      for (const name of names) variables[name] = store.get(name);
      const result = await runWorker(code, variables);
      if (!result.ok) { failures++; return { ...result, availableVariables: names, attempt: failures, maxAttempts: 3 }; }
      failures = 0;
      if (!result.returned) return { ok: true, display: result.display, truncated: result.truncated, note: "Inspection only. Nothing returned or stored." };
      const stub = store.maybeCapture("code", result.value, true);
      if (stub && typeof stub === "object" && "error" in stub) return { ok: false, ...(stub as object) };
      return { ok: true, ...stub as object, ...(result.display ? { display: result.display } : {}), ...(result.truncated ? { truncated: true } : {}) };
    },
  });
}
