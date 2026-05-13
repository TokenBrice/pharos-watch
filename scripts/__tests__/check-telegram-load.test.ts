import { describe, expect, it } from "vitest";

import {
  buildSyntheticTelegramFixture,
  buildTelegramLoadCheckReport,
  evaluateQueryPlan,
  simulateLoadScenarios,
  summarizeFixture,
  type QueryPlanCheckDefinition,
} from "../check-telegram-load";

describe("Telegram load simulation", () => {
  it("builds fixtures that cover the required subscriber states", () => {
    const fixture = buildSyntheticTelegramFixture(5_000);
    const summary = summarizeFixture(fixture);

    expect(summary.activeWatchers).toBe(5_000);
    expect(summary.directSubscriptions).toBeGreaterThan(25_000);
    expect(summary.globalOptIns.depeg).toBeGreaterThan(2_500);
    expect(summary.globalOptIns.dews).toBeGreaterThan(100);
    expect(summary.globalOptIns.safety).toBeGreaterThan(300);
    expect(summary.presetFollowers).toBeGreaterThan(350);
    expect(summary.groupChats).toBeGreaterThan(600);
    expect(summary.quietHoursChats).toBeGreaterThan(250);
    expect(summary.chatSnoozes).toBeGreaterThan(100);
    expect(summary.perCoinSnoozes).toBeGreaterThan(500);
    expect(summary.blockedChats).toBeGreaterThan(50);
  });

  it("simulates all Phase 5 fan-out scenarios for a target fixture", () => {
    const fixture = buildSyntheticTelegramFixture(1_000);
    const scenarios = simulateLoadScenarios(fixture);

    expect(scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "single-depeg",
      "market-wide-burst",
      "dews-safety-burst",
      "admin-broadcast",
      "telegram-429-storm",
    ]);
    expect(scenarios.every((scenario) => scenario.targetChats > 0)).toBe(true);
    expect(scenarios.every((scenario) => scenario.d1Operations.reads > 0)).toBe(true);
    expect(scenarios.every((scenario) => scenario.d1Operations.writes > 0)).toBe(true);
  });

  it("includes the 500, 1000, 5000, and 10000 watcher targets by default", () => {
    const report = buildTelegramLoadCheckReport({ skipQueryPlans: true });

    expect(report.fixtureSummaries.map((summary) => summary.activeWatchers)).toEqual([500, 1_000, 5_000, 10_000]);
    expect(report.scenarios).toHaveLength(20);
    expect(report.scenarios.filter((scenario) => scenario.exploratory)).toHaveLength(5);
  });

  it("meets the required 5000-watcher delivery SLO scenarios", () => {
    const report = buildTelegramLoadCheckReport({ targets: [5_000], skipQueryPlans: true });
    const requiredScenarios = report.scenarios.filter((scenario) =>
      scenario.scenarioId === "single-depeg" ||
      scenario.scenarioId === "market-wide-burst" ||
      scenario.scenarioId === "dews-safety-burst" ||
      scenario.scenarioId === "telegram-429-storm",
    );

    expect(report.assumptions.freshAttemptsPerRun).toBe(3_600);
    expect(report.assumptions.pendingDrainAttemptsPerRun).toBe(900);
    expect(requiredScenarios.every((scenario) => scenario.sloStatus !== "breach")).toBe(true);
  });
});

describe("Telegram query-plan evaluation", () => {
  const check: QueryPlanCheckDefinition = {
    id: "example",
    category: "fan-out",
    sql: "SELECT 1",
    binds: [],
    requiredDetails: ["idx_needed"],
  };

  it("passes when required index details are present", () => {
    const result = evaluateQueryPlan(check, ["SEARCH sub USING INDEX idx_needed (stablecoin_id=?)"]);

    expect(result.status).toBe("ok");
    expect(result.missingRequiredDetails).toEqual([]);
  });

  it("fails when a required index detail is missing", () => {
    const result = evaluateQueryPlan(check, ["SCAN sub"]);

    expect(result.status).toBe("fail");
    expect(result.missingRequiredDetails).toEqual(["idx_needed"]);
    expect(result.unexpectedFullScanTables).toEqual(["sub"]);
  });

  it("marks allowed aggregate scans for review instead of failure", () => {
    const result = evaluateQueryPlan(
      {
        ...check,
        requiredDetails: [],
        allowedFullScanTables: ["telegram_subscribers"],
      },
      ["SCAN telegram_subscribers"],
    );

    expect(result.status).toBe("review");
    expect(result.unexpectedFullScanTables).toEqual([]);
  });
});
