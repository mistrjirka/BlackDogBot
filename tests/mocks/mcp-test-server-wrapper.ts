import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

//#region Types

export interface ITestMcpServer {
  process: ChildProcess;
  cleanup: () => void;
}

//#endregion Types

//#region Public Functions

export function startTestMcpServer(): ITestMcpServer {
  const command = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const args = ["tests/mocks/mcp-test-server.ts"];

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  const cleanup = (): void => {
    if (!proc.killed) {
      proc.kill();
    }
    proc.stdin?.destroy();
    proc.stdout?.destroy();
    proc.stderr?.destroy();
  };

  return {
    process: proc,
    cleanup,
  };
}

//#endregion Public Functions
