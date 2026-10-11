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
    ["frontend-to-worker.fixture", "src/lib/__boundary-fixture.ts", "no-restricted-imports"],
    ["frontend-to-worker.fixture", "scripts/ci/__boundary-fixture.ts", "no-restricted-imports"],
    ["worker-to-frontend.fixture", "worker/src/__boundary-fixture.ts", "pharos/worker-import-boundaries"],
    ["api-to-cron.fixture", "worker/src/api/__boundary-fixture.ts", "pharos/worker-import-boundaries"],
    ["cron-to-api.fixture", "worker/src/cron/__boundary-fixture.ts", "pharos/worker-import-boundaries"],
  ])("rejects %s at %s", async (fixture, filePath, ruleId) => {
    const messages = await lintFixture(fixture, filePath);
    expect(messages.some((message) => message.ruleId === ruleId && message.severity === 2)).toBe(true);
  });

  it("permits shared imports from the frontend", async () => {
    const [result] = await eslint.lintText('export { sha256Hex } from "@shared/lib/sha256";', {
      filePath: "src/lib/__boundary-fixture.ts",
    });
    expect(result.messages.filter((message) => message.severity === 2)).toEqual([]);
  });

  it("keeps the documented frozen-invariants waiver", async () => {
    const messages = await lintFixture(
      "documented-waiver.fixture",
      "scripts/ci/check-frozen-invariants.ts",
    );
    expect(messages.filter((message) => message.severity === 2)).toEqual([]);
  });
});

it.each(["src/lib/__boundary-fixture.ts", "shared/__boundary-fixture.ts", "scripts/__boundary-fixture.ts", "functions/__boundary-fixture.ts"])("rejects dynamic Worker imports from %s", async (filePath) => {
  const [result] = await eslint.lintText('export const load = () => import("worker/src/lib/auth");', { filePath });
  expect(result.messages.some((message) => message.ruleId === "pharos/frontend-dynamic-import-boundaries")).toBe(true);
});

it("rejects static template Worker imports", async () => {
  const [result] = await eslint.lintText('export const load = () => import(`../../worker/src/lib/auth`);', { filePath: "src/lib/__boundary-fixture.ts" });
  expect(result.messages.some((message) => message.ruleId === "pharos/frontend-dynamic-import-boundaries")).toBe(true);
});

describe("ESLint shared alias boundary", () => {
  const callerPaths = [
    ["src/lib/__boundary-fixture.ts", "../../shared/lib/sha256"],
    ["worker/src/lib/__boundary-fixture.ts", "../../../shared/lib/sha256"],
    ["functions/__boundary-fixture.ts", "../shared/lib/sha256"],
  ];

  const importForms = [
    ['import "{{specifier}}";'],
    ['export { sha256Hex } from "{{specifier}}";'],
    ['export * from "{{specifier}}";'],
    ['export const load = () => import("{{specifier}}");'],
    ["export const load = () => import(`{{specifier}}`);"],
  ];

  describe.each(callerPaths)("caller %s", (filePath, specifier) => {
    it.each(importForms)("rejects relative root-shared imports in %s", async (source) => {
      const [result] = await eslint.lintText(source.replace("{{specifier}}", specifier), { filePath });
      expect(result.messages.filter((message) => message.ruleId === "pharos/require-shared-alias")).toMatchObject([
        { severity: 2, messageId: "alias" },
      ]);
    });

    it.each(importForms)("permits the shared alias in %s", async (source) => {
      const [result] = await eslint.lintText(source.replace("{{specifier}}", "@shared/lib/sha256"), { filePath });
      expect(result.messages.filter((message) => message.severity === 2)).toEqual([]);
    });
  });

  it("resolves normalized paths instead of guessing shared path patterns", async () => {
    const [result] = await eslint.lintText('export * from "../lib/../../shared/lib/sha256";', {
      filePath: "src/lib/__boundary-fixture.ts",
    });
    expect(result.messages.filter((message) => message.ruleId === "pharos/require-shared-alias")).toMatchObject([
      { severity: 2, messageId: "alias" },
    ]);
  });

  it.each([
    ["shared/lib/__boundary-fixture.ts", "./sha256"],
    ["shared/lib/__boundary-fixture.ts", "../types"],
    ["src/lib/coverage/__boundary-fixture.ts", "./shared"],
    ["worker/src/cron/dex-discovery/__boundary-fixture.ts", "../shared/capped-delete"],
    ["functions/local/__boundary-fixture.ts", "../shared/helper"],
    ["src/lib/__boundary-fixture.ts", "../../shared-other/helper"],
    ["scripts/__boundary-fixture.ts", "../shared/lib/sha256"],
  ])("permits relative imports from %s to %s", async (filePath, specifier) => {
    const [result] = await eslint.lintText(`export * from "${specifier}";`, { filePath });
    expect(result.messages.filter((message) => message.severity === 2)).toEqual([]);
  });

  it("retains the alias ban within production shared/lib", async () => {
    const [result] = await eslint.lintText('export { sha256Hex } from "@shared/lib/sha256";', {
      filePath: "shared/lib/__boundary-fixture.ts",
    });
    expect(result.messages.some((message) => message.ruleId === "no-restricted-imports" && message.severity === 2)).toBe(true);
  });
});
