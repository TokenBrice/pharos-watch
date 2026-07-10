import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  hasTelegramLoadGuardImpact,
  isTelegramLoadGuardDependency,
  matchesTelegramLoadGuardPattern,
  TELEGRAM_LOAD_ADVISORY_COMMAND,
  TELEGRAM_LOAD_GUARD_DEPENDENCY_GROUPS,
  TELEGRAM_LOAD_GUARD_PATHS,
} from "../lib/telegram-load-guard.mjs";
import { buildCommandPlan } from "../maintenance/test-merge-gate.mjs";
import { commandTexts } from "../test-utils/ci-script-test-helpers";

function extractTelegramWorkflowPaths(workflow: string): string[] {
  const lines = workflow.split(/\r?\n/);
  const pullRequestIndex = lines.findIndex((line) => line.trim() === "pull_request:");
  const pathsIndex = lines.findIndex(
    (line, index) => index > pullRequestIndex && /^\s{4}paths:\s*$/.test(line),
  );
  const paths: string[] = [];

  for (const line of lines.slice(pathsIndex + 1)) {
    const match = line.match(/^\s{6}-\s+"([^"]+)"\s*$/);
    if (!match) break;
    paths.push(match[1]);
  }
  return paths;
}

describe("Telegram load guard dependency registry", () => {
  it("keeps the GitHub pull-request filter aligned with the reviewed registry", () => {
    const workflow = readFileSync(
      resolve(process.cwd(), ".github/workflows/telegram-load.yml"),
      "utf8",
    );

    expect(extractTelegramWorkflowPaths(workflow)).toEqual(TELEGRAM_LOAD_GUARD_PATHS);
    expect(new Set(TELEGRAM_LOAD_GUARD_PATHS).size).toBe(TELEGRAM_LOAD_GUARD_PATHS.length);
  });

  it("covers every reviewed dependency group and its representative paths", () => {
    expect(TELEGRAM_LOAD_GUARD_DEPENDENCY_GROUPS.map((group) => group.id)).toEqual([
      "guard-contract",
      "delivery-policy",
      "dispatch-and-pending",
      "job-target-schema",
      "sender",
      "preset-resolution",
      "formatter-and-chunker",
      "scheduled-lane",
      "admin-broadcast",
    ]);

    for (const group of TELEGRAM_LOAD_GUARD_DEPENDENCY_GROUPS) {
      expect(group.reason.length).toBeGreaterThan(0);
      for (const example of group.examples) {
        expect(
          group.paths.some((pattern) => matchesTelegramLoadGuardPattern(example, pattern)),
          `${group.id} does not cover ${example}`,
        ).toBe(true);
        expect(isTelegramLoadGuardDependency(example)).toBe(true);
      }
    }
  });

  it("uses the same registry to select the local merge-gate advisory", () => {
    for (const group of TELEGRAM_LOAD_GUARD_DEPENDENCY_GROUPS) {
      const representative = group.examples[0];
      expect(hasTelegramLoadGuardImpact([representative])).toBe(true);
      if (group.id !== "guard-contract") {
        expect(commandTexts(buildCommandPlan([representative]))).toContain(TELEGRAM_LOAD_ADVISORY_COMMAND);
      }
    }

    expect(hasTelegramLoadGuardImpact(["worker/src/api/unrelated.ts"])).toBe(false);
  });
});
