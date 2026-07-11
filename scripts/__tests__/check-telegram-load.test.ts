import { describe, expect, it } from "vitest";

import {
  buildQueryPlanChecks,
  buildSyntheticTelegramFixture,
  buildTelegramLoadCheckReport,
  evaluateQueryPlan,
  evaluateStatusPathBudget,
  findCpuBudgetBreaches,
  findTtlMarginBreaches,
  runStatusPathBudgetChecks,
  simulateLoadScenarios,
  STATUS_PATH_MAX_DURATION_MS,
  summarizeFixture,
  type QueryPlanCheckDefinition,
  type TelegramLoadCheckReport,
} from "../ci/check-telegram-load";

describe("Telegram load simulation", () => {
  it("builds fixtures that cover the required subscriber states", () => {
    const fixture = buildSyntheticTelegramFixture(5_000);
    const summary = summarizeFixture(fixture);

    expect(summary.activeWatchers).toBe(5_000);
    expect(summary.directSubscriptions).toBeGreaterThan(25_000);
    expect(summary.globalOptIns.depeg).toBeGreaterThan(2_500);
    expect(summary.globalOptIns.dews).toBeGreaterThan(100);
    expect(summary.globalOptIns.safety).toBeGreaterThan(300);
    expect(summary.globalOptIns.reserve).toBeGreaterThan(50);
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
    expect(scenarios.find((scenario) => scenario.scenarioId === "dews-safety-burst")?.scenarioLabel)
      .toContain("reserve");
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
    expect(report.assumptions.pendingDrainAttemptsPerRun).toBe(1_800);
    expect(report.assumptions.sendLoopSoftDeadlineSeconds).toBe(4 * 60);
    expect(requiredScenarios.every((scenario) => scenario.sloStatus !== "breach")).toBe(true);
    expect(requiredScenarios.every((scenario) => scenario.initialFreshAttempts === 0)).toBe(true);
    expect(requiredScenarios.every((scenario) => scenario.ttlMarginFraction >= 0.2)).toBe(true);
    expect(findTtlMarginBreaches(report)).toEqual([]);
    expect(requiredScenarios.find((scenario) => scenario.scenarioId === "telegram-429-storm"))
      .toMatchObject({ sloStatus: "outage-unavailable", outageUnavailableSeconds: 15 * 60 });
  });

  it("computes a per-invocation CPU estimate and keeps the required burst under the safety fraction", () => {
    const report = buildTelegramLoadCheckReport({ targets: [5_000], skipQueryPlans: true });

    expect(report.assumptions.dispatchCpuMs).toBeGreaterThan(0);
    expect(report.assumptions.cpuBudgetSafetyFraction).toBe(0.5);
    expect(report.assumptions.cpuBudgetCeilingMs).toBe(
      report.assumptions.dispatchCpuMs * report.assumptions.cpuBudgetSafetyFraction,
    );

    const requiredScenarios = report.scenarios.filter(
      (scenario) => scenario.targetActiveWatchers === 5_000,
    );
    expect(requiredScenarios.length).toBeGreaterThan(0);
    for (const scenario of requiredScenarios) {
      expect(scenario.estimatedCpuMs).toBeGreaterThan(0);
      // C102 caps modeled format-count at the fresh budget, so every required
      // scenario stays under the CPU safety fraction of the per-invocation cap.
      expect(scenario.estimatedCpuMs).toBeLessThanOrEqual(report.assumptions.cpuBudgetCeilingMs);
    }
  });

  it("caps the modeled format-count at the fresh budget post-C102 reorder", () => {
    const report = buildTelegramLoadCheckReport({ targets: [5_000], skipQueryPlans: true });
    const burst = report.scenarios.find(
      (scenario) =>
        scenario.targetActiveWatchers === 5_000 && scenario.scenarioId === "market-wide-burst",
    );

    expect(burst).toBeDefined();
    // The burst routes far more chunks than the fresh budget, but the CPU model
    // formats at most `freshAttemptsPerRun` chats on the hot path — without the
    // cap the estimate would scale with the full chunk count and exceed budget.
    expect(burst!.messageChunks).toBeGreaterThan(report.assumptions.freshAttemptsPerRun);
    const uncappedFormatMs = burst!.messageChunks * report.assumptions.formatCpuMsPerChat;
    const cappedFormatMs = report.assumptions.freshAttemptsPerRun * report.assumptions.formatCpuMsPerChat;
    expect(cappedFormatMs).toBeLessThan(uncappedFormatMs);
    expect(burst!.estimatedCpuMs).toBeLessThanOrEqual(report.assumptions.cpuBudgetCeilingMs);
  });

  it("flags a synthetic over-budget scenario and passes the real fixtures", () => {
    const report = buildTelegramLoadCheckReport({ targets: [5_000], skipQueryPlans: true });

    // Real fixtures stay under the CPU safety fraction.
    expect(findCpuBudgetBreaches(report)).toEqual([]);

    // A synthetic required-target scenario over the ceiling trips the gate.
    const overBudget: TelegramLoadCheckReport = {
      ...report,
      scenarios: [
        ...report.scenarios,
        {
          ...report.scenarios[0]!,
          targetActiveWatchers: 5_000,
          estimatedCpuMs: report.assumptions.cpuBudgetCeilingMs + 1,
        },
      ],
    };
    expect(findCpuBudgetBreaches(overBudget)).toHaveLength(1);

    // A non-required-target over-budget scenario must NOT trip the gate.
    const exploratoryOver: TelegramLoadCheckReport = {
      ...report,
      scenarios: [
        {
          ...report.scenarios[0]!,
          targetActiveWatchers: 10_000,
          estimatedCpuMs: report.assumptions.cpuBudgetCeilingMs + 5_000,
        },
      ],
    };
    expect(findCpuBudgetBreaches(exploratoryOver)).toEqual([]);
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

  it("keeps only the claim-based pending drain readiness guard", () => {
    const pendingDrainIds = buildQueryPlanChecks()
      .filter((check) => check.category === "pending-drain")
      .map((check) => check.id);

    expect(pendingDrainIds).toContain("pending-claim-ready");
    expect(pendingDrainIds).not.toContain("pending-drain-ready");
  });

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

describe("Telegram status-path budgets", () => {
  const budgetedCheck: QueryPlanCheckDefinition = {
    id: "example-status-path",
    category: "pulse-status",
    sql: "SELECT 1",
    binds: [],
    budget: {
      rowsReadTables: ["telegram_subscriptions"],
      maxRowsRead: 30_000,
      maxDurationMs: STATUS_PATH_MAX_DURATION_MS,
    },
  };

  it("defines a reviewed budget for every status read path", () => {
    const statusPathChecks = buildQueryPlanChecks().filter(
      (check) => check.category === "pulse-status" || check.category === "lifecycle",
    );

    expect(statusPathChecks.map((check) => check.id)).toEqual([
      "pulse-aggregate",
      "status-top-stablecoins",
      "lifecycle-current-active-history",
    ]);
    for (const check of statusPathChecks) {
      expect(check.budget?.rowsReadTables.length).toBeGreaterThan(0);
      expect(check.budget?.maxRowsRead).toBeGreaterThan(0);
      expect(check.budget?.maxDurationMs).toBeGreaterThan(0);
      if (
        check.id === "pulse-aggregate" ||
        check.id === "status-top-stablecoins" ||
        check.id === "lifecycle-current-active-history"
      ) {
        expect(check.budget?.rowsReadTables).toContain("telegram_preset_subscriptions");
      }
    }
  });

  it("models the two production top-followed aggregate queries", () => {
    const check = buildQueryPlanChecks().find((candidate) => candidate.id === "status-top-stablecoins");

    expect(check?.sql).toContain("COUNT(DISTINCT chat_id)");
    expect(check?.sql.match(/COUNT\(DISTINCT chat_id\)/g)).toHaveLength(2);
    expect(check?.sql).toContain("GROUP BY stablecoin_id");
    expect(check?.sql).toContain("GROUP BY preset_id");
    expect(check?.sql).not.toContain("GROUP BY source_id");
    expect(check?.allowedFullScanTables).toEqual([
      "telegram_subscriptions",
      "telegram_preset_subscriptions",
    ]);
  });

  it("passes a measurement within the reviewed maxima", () => {
    const result = evaluateStatusPathBudget(budgetedCheck, budgetedCheck.budget!, {
      rowsRead: 28_334,
      durationMs: 5,
      seededRowCounts: { telegram_subscriptions: 28_334 },
    });

    expect(result.status).toBe("ok");
    expect(result.rowsRead).toBe(28_334);
    expect(result.maxRowsRead).toBe(30_000);
  });

  it("fails a measurement that exceeds the reviewed rows-read maximum", () => {
    const result = evaluateStatusPathBudget(budgetedCheck, budgetedCheck.budget!, {
      rowsRead: 30_001,
      durationMs: 5,
      seededRowCounts: { telegram_subscriptions: 30_001 },
    });

    expect(result.status).toBe("fail");
  });

  it("fails a measurement that exceeds the reviewed duration maximum", () => {
    const result = evaluateStatusPathBudget(budgetedCheck, budgetedCheck.budget!, {
      rowsRead: 28_334,
      durationMs: STATUS_PATH_MAX_DURATION_MS + 1,
      seededRowCounts: { telegram_subscriptions: 28_334 },
    });

    expect(result.status).toBe("fail");
  });

  it("measures each status path against the seeded planning-target fixture", () => {
    const results = runStatusPathBudgetChecks();

    expect(results.map((result) => result.id)).toEqual([
      "pulse-aggregate",
      "status-top-stablecoins",
      "lifecycle-current-active-history",
    ]);
    for (const result of results) {
      expect(result.status).toBe("ok");
      expect(result.targetActiveWatchers).toBe(5_000);
      expect(result.rowsRead).toBe(
        Object.values(result.seededRowCounts).reduce((sum, count) => sum + count, 0),
      );
      expect(result.rowsRead).toBeGreaterThan(5_000);
      expect(result.durationMs).toBeLessThanOrEqual(result.maxDurationMs);
    }
  });
});
