import { ToolSet, LanguageModel } from "ai";

import { AiProviderService } from "../services/ai-provider.service.js";
import { buildMainAgentPromptAsync } from "./system-prompt.js";
import { BaseAgentBase, type IAgentResult } from "./base-agent.js";
import {
  thinkTool,
  runCmdTool,
  modifyPromptTool,
  listPromptsTool,
  searchKnowledgeTool,
  addKnowledgeTool,
  editKnowledgeTool,
  createSendMessageTool,
  addJobTool,
  editJobTool,
  removeJobTool,
  getJobsTool,
  runJobTool,
  finishJobTool,
  addNodeTool,
  editNodeTool,
  removeNodeTool,
  connectNodesTool,
  setEntrypointTool,
  addNodeTestTool,
  runNodeTestTool,
  callSkillTool,
  getSkillFileTool,
  type MessageSender,
} from "../tools/index.js";

//#region MainAgent

export class MainAgent extends BaseAgentBase {
  //#region Data members

  private static _instance: MainAgent | null;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    super();
    MainAgent._instance = null;
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): MainAgent {
    if (!MainAgent._instance) {
      MainAgent._instance = new MainAgent();
    }

    return MainAgent._instance;
  }

  public async initializeAsync(messageSender: MessageSender): Promise<void> {
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model: LanguageModel = aiProviderService.getModel();
    const instructions: string = await buildMainAgentPromptAsync();

    const tools: ToolSet = {
      think: thinkTool,
      run_cmd: runCmdTool,
      modify_prompt: modifyPromptTool,
      list_prompts: listPromptsTool,
      search_knowledge: searchKnowledgeTool,
      add_knowledge: addKnowledgeTool,
      edit_knowledge: editKnowledgeTool,
      send_message: createSendMessageTool(messageSender),
      add_job: addJobTool,
      edit_job: editJobTool,
      remove_job: removeJobTool,
      get_jobs: getJobsTool,
      run_job: runJobTool,
      finish_job: finishJobTool,
      add_node: addNodeTool,
      edit_node: editNodeTool,
      remove_node: removeNodeTool,
      connect_nodes: connectNodesTool,
      set_entrypoint: setEntrypointTool,
      add_node_test: addNodeTestTool,
      run_node_test: runNodeTestTool,
      call_skill: callSkillTool,
      get_skill_file: getSkillFileTool,
    };

    this._buildAgent(model, instructions, tools);
    this._logger.info("MainAgent initialized.");
  }

  //#endregion Public methods
}

//#endregion MainAgent

export type { IAgentResult };
