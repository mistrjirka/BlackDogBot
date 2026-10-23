import { describe, expect, it } from "vitest";
import { AiProviderService } from "../../src/services/ai-provider.service.js";
import { LlmIncompleteResponseError } from "../../src/utils/llm-fetch.js";

describe("incomplete model response", () => {
  it("rejects an unfinished reasoning block", async () => {
    const service = AiProviderService.getInstance() as unknown as { _fixReasoningContentResponse: (r: Response) => Promise<Response> };
    const response = new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "<think>unfinished" } }] }));
    await expect(service._fixReasoningContentResponse(response)).rejects.toBeInstanceOf(LlmIncompleteResponseError);
  });

  it("does not expose a completed reasoning block in final content", async () => {
    const service = AiProviderService.getInstance() as unknown as { _fixReasoningContentResponse: (r: Response) => Promise<Response> };
    const response = new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "<think>private thoughts</think>Visible answer" } }] }));
    const cleaned = await service._fixReasoningContentResponse(response);
    const result = await cleaned.json() as { choices: { message: { content: string; reasoning_content: string } }[] };
    expect(result.choices[0].message.content).toBe("Visible answer");
    expect(result.choices[0].message.reasoning_content).toBe("private thoughts");
  });

  it("rejects private reasoning without any visible answer", async () => {
    const service = AiProviderService.getInstance() as unknown as { _fixReasoningContentResponse: (r: Response) => Promise<Response> };
    const response = new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "", reasoning_content: "private reasoning" } }] }));
    await expect(service._fixReasoningContentResponse(response)).rejects.toBeInstanceOf(LlmIncompleteResponseError);
  });

  it("rejects length completion", async () => {
    const service = AiProviderService.getInstance() as unknown as {
      _fixReasoningContentResponse: (r: Response) => Promise<Response>;
    };
    const response = new Response(JSON.stringify({
      choices: [{ finish_reason: "length", message: { content: "unfinished answer" } }],
    }));
    await expect(service._fixReasoningContentResponse(response)).rejects.toBeInstanceOf(LlmIncompleteResponseError);
  });
});
