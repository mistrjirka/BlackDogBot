import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { tool } from "ai";
import { z } from "zod";

const schema = z.object({
  patch: z.string().min(1).max(1_000_000).describe("Unified diff (git apply format), with ---/+++ paths and @@ hunks; applies atomically after checking all hunks."),
  cwd: z.string().optional().describe("Directory containing paths in the patch; default ~/.blackdogbot/workspace/"),
});

async function gitApply(cwd: string, patch: string, check: boolean): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", ["apply", ...(check ? ["--check"] : []), "--whitespace=nowarn", "-"], {
      cwd, stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString().slice(0, 1500); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString().slice(0, 1500); });
    child.on("error", (error) => resolve({ ok: false, output: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, output: output.slice(0, 3000) }));
    child.stdin.on("error", () => {});
    child.stdin.end(patch);
  });
}

/** Multi-file, context-checked patch editing. Uses git apply rather than a shell;
 * file paths outside cwd and malformed hunks are rejected by git apply. */
export const applyPatchTool = tool({
  description: "Apply a multi-file unified diff. All hunks are checked before writing; fails without edits if context mismatches. Use for source-code modifications; exact replacements can still use edit_file.",
  inputSchema: schema,
  execute: async ({ patch, cwd }) => {
    const root = cwd ? path.resolve(cwd.replace(/^~(?=\/|$)/, os.homedir())) : path.join(os.homedir(), ".blackdogbot", "workspace");
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) return { success: false, error: "cwd is not a directory" };
      const check = await gitApply(root, patch, true);
      if (!check.ok) return { success: false, error: "Patch context/syntax check failed: " + check.output };
      const result = await gitApply(root, patch, false);
      return result.ok
        ? { success: true, message: "Patch applied successfully" }
        : { success: false, error: "Patch failed: " + result.output };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
});
