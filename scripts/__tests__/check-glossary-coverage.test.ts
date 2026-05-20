import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("check-glossary-coverage CLI", () => {
  it("passes on the current ai-summaries.json with every {{term:slug}} resolved in the glossary", () => {
    const stdout = execFileSync("npx", ["tsx", "scripts/ci/check-glossary-coverage.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    expect(stdout).toMatch(/Glossary coverage: \d+ markers across \d+ unique slug\(s\) OK/);
  });
});
