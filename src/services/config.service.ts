import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { configSchema, ConfigSchemaType } from "../shared/schemas/index.js";
import { IConfig } from "../shared/types/index.js";
import { getConfigPath, ensureDirectoryExistsAsync } from "../utils/paths.js";

export class ConfigService {
  //#region Data members

  private static _instance: ConfigService | null;
  private _config: IConfig | null;
  private _configPath: string;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    this._config = null;
    this._configPath = "";
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): ConfigService {
    if (!ConfigService._instance) {
      ConfigService._instance = new ConfigService();
    }

    return ConfigService._instance;
  }

  public async initializeAsync(configPath?: string): Promise<void> {
    this._configPath = configPath ?? getConfigPath();

    let fileContent: string;

    try {
      fileContent = await fs.readFile(this._configPath, "utf-8");
    } catch {
      throw new Error(
        `Config file not found at ${this._configPath}. Create one or copy from .env.example.`,
      );
    }

    const rawConfig: unknown = parseYaml(fileContent);
    const parsedConfig: ConfigSchemaType = configSchema.parse(rawConfig);

    this._config = parsedConfig as IConfig;
  }

  public getConfig(): IConfig {
    if (!this._config) {
      throw new Error(
        "ConfigService not initialized. Call initializeAsync() first.",
      );
    }

    return this._config;
  }

  public getAiConfig(): IConfig["ai"] {
    return this.getConfig().ai;
  }

  public getTelegramConfig(): IConfig["telegram"] | undefined {
    return this.getConfig().telegram;
  }

  public getSchedulerConfig(): IConfig["scheduler"] {
    return this.getConfig().scheduler;
  }

  public getKnowledgeConfig(): IConfig["knowledge"] {
    return this.getConfig().knowledge;
  }

  public getSkillsConfig(): IConfig["skills"] {
    return this.getConfig().skills;
  }

  public getLoggingConfig(): IConfig["logging"] {
    return this.getConfig().logging;
  }

  public async saveConfigAsync(): Promise<void> {
    const config: IConfig = this.getConfig();
    const parentDir: string = path.dirname(this._configPath);

    await ensureDirectoryExistsAsync(parentDir);

    const yamlContent: string = stringifyYaml(config);

    await fs.writeFile(this._configPath, yamlContent, "utf-8");
  }

  public async updateConfigAsync(updates: Partial<IConfig>): Promise<void> {
    const currentConfig: IConfig = this.getConfig();
    const mergedConfig: IConfig = { ...currentConfig, ...updates };
    const validatedConfig: ConfigSchemaType = configSchema.parse(mergedConfig);

    this._config = validatedConfig as IConfig;

    await this.saveConfigAsync();
  }

  //#endregion Public methods
}
