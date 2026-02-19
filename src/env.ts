import dotenv from "dotenv";
import path from "node:path";
import os from "node:os";

// Load ~/.betterclaw/.env first (user-level), then ./.env (project root).
// Neither call overrides values already set in the shell environment.
const userEnvPath: string = path.join(os.homedir(), ".betterclaw", ".env");

dotenv.config({ path: userEnvPath, override: false });
dotenv.config({ path: path.resolve(".env"), override: false });
