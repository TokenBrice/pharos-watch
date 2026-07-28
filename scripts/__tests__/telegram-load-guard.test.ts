import { describe, expect, it } from "vitest";

import {
  hasTelegramLoadGuardImpact,
  isTelegramLoadGuardDependency,
  matchesTelegramLoadGuardPattern,
  TELEGRAM_LOAD_ADVISORY_COMMAND,
  TELEGRAM_LOAD_GUARD_DEPENDENCY_GROUPS,
  TELEGRAM_LOAD_GUARD_PATHS,
} from "../lib/telegram-load-guard.mjs";
import { buildPrStaticCheckPlan } from "../maintenance/run-pr-static-checks.mjs";

describe("Telegram load guard dependency registry", () => {
  it("keeps the reviewed dependency paths unique", () => {
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

  it("uses the same registry to select the adaptive PR check", () => {
    for (const group of TELEGRAM_LOAD_GUARD_DEPENDENCY_GROUPS) {
      const representative = group.examples[0];
      expect(hasTelegramLoadGuardImpact([representative])).toBe(true);
      expect(buildPrStaticCheckPlan([representative]).commands.map(({ name }) => `npm run ${name}`)).toContain(
        TELEGRAM_LOAD_ADVISORY_COMMAND,
      );
    }

    expect(hasTelegramLoadGuardImpact(["scripts/lib/telegram-load-scenarios.ts"])).toBe(true);
    expect(
      buildPrStaticCheckPlan(["scripts/lib/telegram-load-scenarios.ts"]).commands.map(({ name }) => `npm run ${name}`),
    ).toContain(TELEGRAM_LOAD_ADVISORY_COMMAND);

    expect(hasTelegramLoadGuardImpact(["worker/src/api/unrelated.ts"])).toBe(false);
  });
});
