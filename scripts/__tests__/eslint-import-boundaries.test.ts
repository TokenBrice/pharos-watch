import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const FIXTURE_ROOT = resolve(process.cwd(), "scripts/__tests__/fixtures/eslint-import-boundaries");
const eslint = new ESLint({ cache: false, cwd: process.cwd(), overrideConfigFile: "eslint.config.mjs" });

async function lintFixture(fixture: string, filePath: string) {
  const [result] = await eslint.lintText(readFileSync(resolve(FIXTURE_ROOT, fixture), "utf8"), { filePath });
  return result.messages;
}

describe("ESLint import boundaries", () => {
  it.each([
    ["frontend-to-worker.fixture", "scripts/ci/__boundary-fixture.ts", "no-restricted-imports"],
    ["worker-to-frontend.fixture", "worker/src/__boundary-fixture.ts", "pharos/worker-import-boundaries"],
    ["api-to-cron.fixture", "worker/src/api/__boundary-fixture.ts", "pharos/worker-import-boundaries"],
    ["cron-to-api.fixture", "worker/src/cron/__boundary-fixture.ts", "pharos/worker-import-boundaries"],
  ])("rejects %s", async (fixture, filePath, ruleId) => {
    const messages = await lintFixture(fixture, filePath);
    expect(messages.some((message) => message.ruleId === ruleId && message.severity === 2)).toBe(true);
  });

  it("keeps the documented frozen-invariants waiver", async () => {
    const messages = await lintFixture(
      "documented-waiver.fixture",
      "scripts/ci/check-frozen-invariants.ts",
    );
    expect(messages.filter((message) => message.severity === 2)).toEqual([]);
  });
});
