import dotenv from "dotenv";
import path from "node:path";
import { getBaseDir } from "./utils/paths.js";

const userEnvPath: string = path.join(getBaseDir(), ".env");

dotenv.config({ path: userEnvPath, override: false });
dotenv.config({ path: path.resolve(".env"), override: false });
