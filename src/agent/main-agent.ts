import { ToolSet, LanguageModel, type ModelMessage } from "ai";

import { AiProviderService } from "../services/ai-provider.service.js";
import { buildMainAgentPromptAsync } from "./system-prompt.js";
import { BaseAgentBase, type IAgentResult, type OnStepCallback } from "./base-agent.js";
import { DEFAULT_AGENT_MAX_STEPS } from "../shared/constants.js";
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
  createRunJobTool,
  finishJobTool,
  createAddNodeTool,
  createEditNodeTool,
  removeNodeTool,
  connectNodesTool,
  setEntrypointTool,
  addNodeTestTool,
  runNodeTestTool,
  callSkillTool,
  getSkillFileTool,
  addCronTool,
  removeCronTool,
  listCronsTool,
  createRenderGraphTool,
  createReadFileTool,
  createWriteFileTool,
  appendFileTool,
  editFileTool,
  fetchRssTool,
  createDoneTool,
  FileReadTracker,
  JobActivityTracker,
  type MessageSender,
  type PhotoSender,
} from "../tools/index.js";

//#region Interfaces

interface IChatSession {
  messages: ModelMessage[];
  lastActivityAt: number;
}

//#endregion Interfaces

//#region MainAgent

export class MainAgent extends BaseAgentBase {
  //#region Data members

  private static _instance: MainAgent | null;
  private _sessions: Map<string, IChatSession>;

  //#endregion Data members

  //#region Constructors

  private constructor() {
    const rawSteps: number = parseInt(process.env.BETTERCLAW_MAIN_AGENT_MAX_STEPS ?? "", 10);

    super({ maxSteps: isNaN(rawSteps) ? DEFAULT_AGENT_MAX_STEPS : rawSteps });
    this._sessions = new Map<string, IChatSession>();
  }

  //#endregion Constructors

  //#region Public methods

  public static getInstance(): MainAgent {
    if (!MainAgent._instance) {
      MainAgent._instance = new MainAgent();
    }

    return MainAgent._instance;
  }

  public async initializeForChatAsync(
    chatId: string,
    messageSender: MessageSender,
    photoSender: PhotoSender,
    onStepAsync?: OnStepCallback,
  ): Promise<void> {
    const aiProviderService: AiProviderService = AiProviderService.getInstance();
    const model: LanguageModel = aiProviderService.getModel();
    const instructions: string = await buildMainAgentPromptAsync();

    const readTracker: FileReadTracker = new FileReadTracker();
    const jobTracker: JobActivityTracker = new JobActivityTracker();

    const tools: ToolSet = {
      think: thinkTool,
      run_cmd: runCmdTool,
      modify_prompt: modifyPromptTool,
      list_prompts: listPromptsTool,
      search_knowledge: searchKnowledgeTool,
      add_knowledge: addKnowledgeTool,
      edit_knowledge: editKnowledgeTool,
      send_message: createSendMessageTool(messageSender),
      read_file: createReadFileTool(readTracker),
      write_file: createWriteFileTool(readTracker),
      append_file: appendFileTool,
      edit_file: editFileTool,
      add_job: addJobTool,
      edit_job: editJobTool,
      remove_job: removeJobTool,
      get_jobs: getJobsTool,
      run_job: createRunJobTool(jobTracker),
      finish_job: finishJobTool,
      add_node: createAddNodeTool(jobTracker),
      edit_node: createEditNodeTool(jobTracker),
      remove_node: removeNodeTool,
      connect_nodes: connectNodesTool,
      set_entrypoint: setEntrypointTool,
      add_node_test: addNodeTestTool,
      run_node_test: runNodeTestTool,
      call_skill: callSkillTool,
      get_skill_file: getSkillFileTool,
      add_cron: addCronTool,
      remove_cron: removeCronTool,
      list_crons: listCronsTool,
      render_graph: createRenderGraphTool(photoSender),
      fetch_rss: fetchRssTool,
    };

    const trackedDoneTool = createDoneTool(jobTracker);

    this._buildAgent(model, instructions, tools, onStepAsync, trackedDoneTool);

    // Create session for this chat if it doesn't exist
    if (!this._sessions.has(chatId)) {
      this._sessions.set(chatId, {
        messages: [],
        lastActivityAt: Date.now(),
      });
    }

    this._logger.info("MainAgent initialized for chat.", { chatId });
  }

  public async processMessageForChatAsync(chatId: string, userMessage: string): Promise<IAgentResult> {
    this._ensureInitialized();

    const session: IChatSession = this._sessions.get(chatId)!;

    session.lastActivityAt = Date.now();

    this._logger.debug("Processing user message", { chatId, messageLength: userMessage.length });

    // Append the user message to session history
    const userModelMessage: ModelMessage = {
      role: "user",
      content: [{ type: "text", text: userMessage }],
    };

    const messagesForCall: ModelMessage[] = [...session.messages, userModelMessage];

    const result = await this._agent!.generate({
      messages: messagesForCall,
    });

    const stepsCount: number = result.steps?.length ?? 1;

    // Persist the conversation: add user message + response messages to session
    session.messages.push(userModelMessage);

    if (result.response?.messages) {
      for (const responseMsg of result.response.messages) {
        session.messages.push(responseMsg as ModelMessage);
      }
    }

    this._logger.debug("Agent response generated", { chatId, stepsCount, historyLength: session.messages.length });

    // If the model produced no text (e.g. was forced to call done at maxSteps without
    // having called send_message), fall back to the done tool's summary so the user
    // always receives a reply.
    let text: string = result.text ?? "";

    if (!text && result.steps) {
      interface IToolCallLike { toolName: string; input: Record<string, unknown>; }
      interface IStepLike { toolCalls?: IToolCallLike[]; }

      const doneCall: IToolCallLike | undefined = (result.steps as IStepLike[])
        .flatMap((s: IStepLike): IToolCallLike[] => s.toolCalls ?? [])
        .find((tc: IToolCallLike): boolean => tc.toolName === "done");

      if (doneCall && typeof doneCall.input?.summary === "string") {
        text = doneCall.input.summary;
      }
    }

    return {
      text,
      stepsCount,
    };
  }

  public clearChatHistory(chatId: string): void {
    this._sessions.delete(chatId);
    this._logger.info("Chat history cleared.", { chatId });
  }

  //#endregion Public methods
}

//#endregion MainAgent

export type { IAgentResult };
