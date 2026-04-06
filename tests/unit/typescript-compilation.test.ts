import { execSync } from "node:child_process";
import { describe, it } from "vitest";

describe("TypeScript compilation", () => {
  it("should compile with no type errors (tsc --noEmit)", () => {
    // Run tsc from the project root; it will throw on any type errors
    const output = execSync("npx tsc --noEmit", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // tsc --noEmit produces no output on success; fail if it does
    expect(output.trim()).toBe("");
  });
});
