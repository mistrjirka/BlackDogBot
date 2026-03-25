import { describe, expect, it } from "vitest";
import type { ModelMessage, ToolSet } from "ai";

import { estimateRequestLikeTokens } from "../../src/utils/token-tracker.js";
import { countRequestBodyTokens } from "../../src/utils/request-token-counter.js";

describe("token tracker image-aware estimation", () => {
  it("adds image token budget when user message contains image part", () => {
    const textOnlyMessages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Describe this image" }],
      } as ModelMessage,
    ];

    const withImageMessages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this image" },
          {
            type: "image",
            image: Buffer.from("A".repeat(16000), "utf-8"),
            mediaType: "image/png",
          },
        ],
      } as ModelMessage,
    ];

    const noTools: ToolSet = {};

    const textOnlyEstimate = estimateRequestLikeTokens(
      textOnlyMessages,
      "System prompt",
      null,
      noTools,
      [],
    );
    const withImageEstimate = estimateRequestLikeTokens(
      withImageMessages,
      "System prompt",
      null,
      noTools,
      [],
    );

    expect(textOnlyEstimate).not.toBeNull();
    expect(withImageEstimate).not.toBeNull();

    const textTotal: number = textOnlyEstimate!.breakdown.total;
    const imageTotal: number = withImageEstimate!.breakdown.total;

    expect(imageTotal).toBeGreaterThan(textTotal);
    expect(withImageEstimate!.breakdown.image).toBeGreaterThan(0);
  });

  it("keeps image estimate zero for text-only request", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello world" }],
      } as ModelMessage,
    ];

    const estimate = estimateRequestLikeTokens(messages, "System prompt", null, {}, []);

    expect(estimate).not.toBeNull();
    expect(estimate!.breakdown.image).toBe(0);
  });

  it("keeps request-like image estimate aligned with hard-gate counter for image_url payload", () => {
    const imageDataUrl: string = `data:image/png;base64,${"A".repeat(30000)}`;
    const requestBody: string = JSON.stringify({
      model: "token-estimation-only",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Please analyze this image" },
            { type: "image_url", image_url: { url: imageDataUrl } },
          ],
        },
      ],
      tools: [],
      system: "System prompt",
    });

    const hardGateBreakdown = countRequestBodyTokens(requestBody);

    expect(hardGateBreakdown.image).toBeGreaterThan(0);
    expect(hardGateBreakdown.total).toBeGreaterThan(hardGateBreakdown.messages);
  });
});
