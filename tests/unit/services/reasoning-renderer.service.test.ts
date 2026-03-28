import { describe, expect, it } from "vitest";

import { ReasoningRendererService } from "../../../src/services/providers/reasoning/reasoning-renderer.service.js";

describe("ReasoningRendererService", () => {
  it("renders reasoning as block quote followed by answer", () => {
    const rendered = ReasoningRendererService.render(
      "line one\nline two",
      "Final answer"
    );

    expect(rendered).toContain("> line one");
    expect(rendered).toContain("> line two");
    expect(rendered).toContain("Final answer");
  });

  it("returns answer only when reasoning absent", () => {
    const rendered = ReasoningRendererService.render("", "Answer only");
    expect(rendered).toBe("Answer only");
  });
});
