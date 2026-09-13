import { describe, expect, it } from "vitest";

import {
  estimateImageTokensFromPart,
  MAX_IMAGE_TOKEN_ESTIMATE,
} from "../../src/utils/image-token-estimator.js";

describe("image token estimation", () => {
  it("estimates canonical v7 file bytes", () => {
    const estimate: number = estimateImageTokensFromPart({
      type: "file",
      data: Uint8Array.from({ length: 1200 }, (): number => 1),
      mediaType: "image/jpeg",
    });

    expect(estimate).toBeGreaterThan(85);
  });

  it("bounds a Telegram-sized JPEG by visual-token cost rather than payload bytes", () => {
    const jpegDataUrl: string = `data:image/jpeg;base64,${"A".repeat(Math.ceil(239336 * 4 / 3))}`;
    const estimate: number = estimateImageTokensFromPart({ type: "image", image: jpegDataUrl });

    expect(estimate).toBe(MAX_IMAGE_TOKEN_ESTIMATE);
    expect(estimate).toBeLessThan(10000);
  });
});
