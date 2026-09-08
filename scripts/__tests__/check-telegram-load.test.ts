import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildQueryPlanChecks,
  buildSyntheticTelegramFixture,
  buildTelegramLoadCheckReport,
  evaluateQueryPlan,
  evaluateStatusPathBudget,
  findCpuBudgetBreaches,
  findProductionDispatchBreaches,
  findRecapLoadBreaches,
  findTtlMarginBreaches,
  runStatusPathBudgetChecks,
  simulateLoadScenarios,
  simulateProductionCalibratedDispatch,
  simulateTelegramRecapLoadScenarios,
  STATUS_PATH_MAX_DURATION_MS,
  summarizeFixture,
  type QueryPlanCheckDefinition,
  type TelegramLoadCheckReport,
} from "../ci/check-telegram-load";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

const databases = createLatestSchemaFixtureTracker();
afterEach(databases.closeAll);

describe("Telegram load simulation", () => {
  let report: TelegramLoadCheckReport;
  beforeAll(() => {
    report = buildTelegramLoadCheckReport({ targets: [5_000], skipQueryPlans: true });
  });

  it("builds fixtures that cover the required subscriber states", () => {
    const fixture = buildSyntheticTelegramFixture(5_000);
    const summary = summarizeFixture(fixture);

    expect(summary.activeWatchers).toBe(5_000);
    expect(summary.directSubscriptions).toBeGreaterThan(25_000);
    expect(summary.globalOptIns.depeg).toBeGreaterThan(2_500);
    expect(summary.globalOptIns.dews).toBeGreaterThan(100);
    expect(summary.globalOptIns.safety).toBeGreaterThan(300);
    expect(summary.globalOptIns.reserve).toBeGreaterThan(50);
    expect(summary.globalOptIns.freeze).toBeGreaterThan(100);
    expect(summary.presetFollowers).toBeGreaterThan(350);
    expect(summary.groupChats).toBeGreaterThan(600);
    expect(summary.quietHoursChats).toBeGreaterThan(250);
    expect(summary.chatSnoozes).toBeGreaterThan(100);
    expect(summary.perCoinSnoozes).toBeGreaterThan(500);
    expect(summary.blockedChats).toBeGreaterThan(50);
  });

  it("simulates every reviewed fan-out scenario for a target fixture", () => {
    const fixture = buildSyntheticTelegramFixture(1_000);
    const scenarios = simulateLoadScenarios(fixture);

    expect(scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "single-depeg",
      "freeze-event",
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
    expect(report.scenarios).toHaveLength(24);
    expect(report.scenarios.filter((scenario) => scenario.exploratory)).toHaveLength(6);
  });

  it("meets the required 5000-watcher delivery SLO scenarios", () => {
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

  it("enforces the production-calibrated candidate, fanout, handoff, and wall-time bounds", () => {
    const scenario = simulateProductionCalibratedDispatch();

    expect(scenario).toMatchObject({
      subscriberCount: 855,
      candidateSubscriberCount: 338,
      targetCount: 300,
      fanoutInputLoadCallCount: scenario.capturePageCount,
      duplicatedFanoutInputLoadCallCount: 0,
      handoffOperationCount: scenario.handoffPageCount * scenario.maxHandoffOperationsPerPage,
    });
    expect(scenario.estimatedInvocationWallMs).toBeLessThanOrEqual(scenario.maxInvocationWallMs);
    expect(findProductionDispatchBreaches(report)).toEqual([]);

    const regressed: TelegramLoadCheckReport = {
      ...report,
      productionDispatchScenario: {
        ...scenario,
        fanoutInputLoadCallCount: scenario.capturePageCount * 2,
        duplicatedFanoutInputLoadCallCount: scenario.capturePageCount,
        handoffOperationCount: scenario.targetCount * 3,
        estimatedInvocationWallMs: scenario.maxInvocationWallMs + 1,
      },
    };
    expect(findProductionDispatchBreaches(regressed)).toEqual([
      "fanout-input-pages-reloaded",
      "duplicated-fanout-input-loads",
      "target-oriented-handoff-operations",
      "invocation-wall-budget",
    ]);
  });

  it("caps the modeled format-count at the fresh budget post-C102 reorder", () => {
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

  it("enforces all seven personalized recap capacity and zero-call scenarios", () => {
    const scenarios = simulateTelegramRecapLoadScenarios(5_000, { riskBurstChunks: 8_000 });

    expect(scenarios.map((scenario) => scenario.scenarioId)).toEqual([
      "recap-all-due",
      "recap-plus-risk-burst",
      "recap-plus-429-storm",
      "recap-preset-heavy",
      "recap-global-scope",
      "recap-no-change",
      "recap-stale-tape",
    ]);
    expect(scenarios.every((scenario) => scenario.ttlMarginFraction >= 0.2)).toBe(true);
    expect(scenarios.every((scenario) => scenario.priorityPreserved)).toBe(true);
    expect(scenarios.every((scenario) => scenario.aiCalls === 0)).toBe(true);
    expect(scenarios.every((scenario) => scenario.externalPlanningFetches === 0)).toBe(true);
    expect(scenarios.find((scenario) => scenario.scenarioId === "recap-no-change"))
      .toMatchObject({ pendingEnqueued: 0, scheduleAdvancements: 5_000 });
    expect(scenarios.find((scenario) => scenario.scenarioId === "recap-stale-tape"))
      .toMatchObject({ pendingEnqueued: 0, scheduleAdvancements: 0 });
  });

  it("emits enforced 5000 and advisory 10000 personalized recap reports", () => {
    const report = buildTelegramLoadCheckReport({ targets: [5_000, 10_000], skipQueryPlans: true });

    expect(report.recapScenarios).toHaveLength(14);
    expect(report.recapScenarios.filter((scenario) => scenario.targetRecipients === 5_000 && !scenario.exploratory)).toHaveLength(7);
    expect(report.recapScenarios.filter((scenario) => scenario.targetRecipients === 10_000 && scenario.exploratory)).toHaveLength(7);
    expect(findRecapLoadBreaches(report)).toEqual([]);
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

  it("excludes terminal job targets from otherwise eligible pending claims", () => {
    const { sqlite } = databases.open();
    const claimCheck = buildQueryPlanChecks().find((candidate) => candidate.id === "pending-claim-ready")!;
    const pending = sqlite.prepare(`INSERT INTO telegram_pending_alerts
      (id, chat_id, message_html, created_at, dedupe_key, priority, delivery_state)
      VALUES (?, 'chat', 'message', 1799999990, ?, 10, ?)`);
    const target = sqlite.prepare(`INSERT INTO telegram_alert_job_targets
      (job_id, target_key, chat_id, alert_type, status, pending_dedupe_key, created_at)
      VALUES ('job', ?, 'chat', 'depeg', ?, ?, 1799999990)`);
    for (const [index, status] of ["sent", "expired", "queued", "planned", "failed"].entries()) {
      const key = `target-${index}`;
      pending.run(index + 1, key, "pending");
      target.run(key, status, key);
    }
    pending.run(6, null, "pending");
    pending.run(7, "already-delivered", "sent");

    expect(sqlite.prepare(claimCheck.sql).all(...claimCheck.binds)).toEqual([
      { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 },
    ]);
    expect(evaluateQueryPlan(claimCheck, sqlite.prepare(`EXPLAIN QUERY PLAN ${claimCheck.sql}`)
      .all(...claimCheck.binds).map((row) => String(row.detail))).status).toBe("ok");
  });

  it("reviews bounded recap planning reads and guarded handoff query plans", () => {
    const recapChecks = buildQueryPlanChecks()
      .filter((check) => check.category === "recap-planner")
      .map((check) => check.id);

    expect(recapChecks).toEqual([
      "recap-due-preferences",
      "recap-tape-window",
      "recap-direct-membership",
      "recap-preset-membership",
      "recap-target-guarded-transition",
      "recap-pending-handoff",
    ]);
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

  it("counts active direct and preset memberships independently without multiplying shared chats", () => {
    const { sqlite } = databases.open();
    const check = buildQueryPlanChecks().find((candidate) => candidate.id === "status-top-stablecoins")!;
    sqlite.exec(`
      INSERT INTO telegram_subscriptions (chat_id, stablecoin_id, alert_dews, alert_depeg, alert_freeze)
      VALUES ('a', 'coin-a', 1, 1, 0), ('b', 'coin-a', 0, 0, 1),
             ('a', 'coin-b', 0, 1, 0), ('c', 'coin-a', 0, 0, 0);
      INSERT INTO telegram_preset_subscriptions
        (chat_id, preset_id, alert_dews, alert_safety, created_at, updated_at)
      VALUES ('a', 'preset-a', 1, 1, 1, 1), ('b', 'preset-a', 0, 1, 1, 1),
             ('a', 'preset-b', 1, 0, 1, 1), ('c', 'preset-a', 0, 0, 1, 1);
    `);

    expect(sqlite.prepare(check.sql).all(...check.binds)
      .sort((a, b) => String(a.source_id).localeCompare(String(b.source_id)))).toEqual([
      { source_id: "coin-a", subscribers: 2 },
      { source_id: "coin-b", subscribers: 1 },
      { source_id: "preset-a", subscribers: 2 },
      { source_id: "preset-b", subscribers: 1 },
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
