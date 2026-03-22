import dotenv from "dotenv";
import path from "node:path";
import { getBaseDir, getLegacyBaseDir, migrateLegacyBaseDirSync } from "./utils/paths.js";

// Load ~/.blackdogbot/.env first (user-level), then ./.env (project root).
// Neither call overrides values already set in the shell environment.
migrateLegacyBaseDirSync();

const userEnvPath: string = path.join(getBaseDir(), ".env");
const legacyUserEnvPath: string = path.join(getLegacyBaseDir(), ".env");

dotenv.config({ path: userEnvPath, override: false });
dotenv.config({ path: legacyUserEnvPath, override: false });
dotenv.config({ path: path.resolve(".env"), override: false });
