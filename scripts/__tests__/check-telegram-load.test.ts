import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildQueryPlanChecks,
  buildTelegramLoadCheckReport,
  evaluateQueryPlan,
  evaluateStatusPathBudget,
  extractProductionStatusSql,
  findCpuBudgetBreaches,
  findProductionDispatchBreaches,
  findTtlMarginBreaches,
  runStatusPathBudgetChecks,
  simulateProductionCalibratedDispatch,
  simulateTelegramRecapLoadScenarios,
  STATUS_PATH_MAX_DURATION_MS,
  type QueryPlanCheckDefinition,
} from "../ci/check-telegram-load";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import type { TelegramLoadCheckReport } from "../lib/telegram-load-report";
import { hasTelegramLoadGuardImpact } from "../lib/telegram-load-guard.mts";

const databases = createLatestSchemaFixtureTracker();
afterEach(databases.closeAll);

describe("Telegram load simulation", () => {
  let report: TelegramLoadCheckReport;
  beforeAll(() => {
    report = buildTelegramLoadCheckReport({ targets: [5_000], skipQueryPlans: true });
  });

  it("derives each target's recap contention from its retained risk-burst scenario", () => {
    const combined = buildTelegramLoadCheckReport({ targets: [1_000, 5_000], skipQueryPlans: true });
    for (const target of [1_000, 5_000]) {
      const scenarios = combined.scenarios.filter((scenario) => scenario.targetActiveWatchers === target);
      expect(scenarios).toHaveLength(6);
      const riskBurst = scenarios.find((scenario) => scenario.scenarioId === "market-wide-burst")!;
      expect(combined.recapScenarios.filter((scenario) => scenario.targetRecipients === target)).toEqual(
        simulateTelegramRecapLoadScenarios(target, { riskBurstChunks: riskBurst.messageChunks }),
      );
    }
  });

  it("classifies the required 5000-watcher SLO across planning and delivery", () => {
    const requiredScenarios = report.scenarios.filter((scenario) =>
      scenario.scenarioId === "single-depeg" ||
      scenario.scenarioId === "market-wide-burst" ||
      scenario.scenarioId === "dews-safety-burst" ||
      scenario.scenarioId === "telegram-429-storm",
    );

    expect(report.assumptions.freshAttemptsPerRun).toBe(3_600);
    expect(report.assumptions.pendingDrainAttemptsPerRun).toBe(1_800);
    expect(report.assumptions.sendLoopSoftDeadlineSeconds).toBe(4 * 60);
    expect(Object.fromEntries(
      requiredScenarios.map((scenario) => [scenario.scenarioId, scenario.sloStatus]),
    )).toEqual({
      "single-depeg": "slow",
      "market-wide-burst": "breach",
      "dews-safety-burst": "slow",
      "telegram-429-storm": "outage-unavailable",
    });
    expect(requiredScenarios.every((scenario) => scenario.initialFreshAttempts === 0)).toBe(true);
    expect(requiredScenarios.every((scenario) => scenario.ttlMarginFraction >= 0.2)).toBe(true);
    expect(findTtlMarginBreaches(report)).toEqual([]);
    expect(requiredScenarios.find((scenario) => scenario.scenarioId === "telegram-429-storm"))
      .toMatchObject({ sloStatus: "outage-unavailable", outageUnavailableSeconds: 15 * 60 });

    const normal = requiredScenarios.find((scenario) => scenario.scenarioId === "single-depeg")!;
    expect(normal.planningDelaySeconds).toBeGreaterThan(0);
    expect(normal.postRecoveryDrainSeconds).toBeLessThanOrEqual(report.assumptions.normalSloSeconds);
    expect(normal.estimatedDrainSeconds).toBeGreaterThan(report.assumptions.normalSloSeconds);
    expect(normal.sloStatus).toBe("slow");
    const pendingSendCpuMs =
      Math.min(normal.pendingEnqueued, report.assumptions.pendingDrainAttemptsPerRun)
      * report.assumptions.sendCpuMsPerMessage;
    expect(pendingSendCpuMs).toBeGreaterThan(0);
    expect(normal.estimatedCpuMs).toBe(
      Math.round(Math.max(
        Math.min(normal.messageChunks, report.assumptions.freshAttemptsPerRun)
          * report.assumptions.formatCpuMsPerChat,
        pendingSendCpuMs,
      )),
    );
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

});

describe("Telegram query-plan evaluation", () => {
  const check: QueryPlanCheckDefinition = {
    id: "example",
    category: "fan-out",
    sql: "SELECT 1",
    binds: [],
    requiredDetails: ["idx_needed"],
  };

  it("excludes only exact-source terminal job targets from otherwise eligible pending claims", () => {
    const { sqlite } = databases.open();
    const claimCheck = buildQueryPlanChecks().find((candidate) => candidate.id === "pending-claim-ready")!;
    const pending = sqlite.prepare(`INSERT INTO telegram_pending_alerts
      (id, chat_id, message_html, created_at, dedupe_key, priority, delivery_state, source_event_id)
      VALUES (?, 'chat', 'message', 1799999990, ?, 10, ?, 'current-source')`);
    const target = sqlite.prepare(`INSERT INTO telegram_alert_job_targets
      (job_id, target_key, chat_id, alert_type, status, pending_dedupe_key, created_at, source_event_id)
      VALUES ('job', ?, 'chat', 'depeg', ?, ?, 1799999990, ?)`);
    for (const [index, status] of ["sent", "expired", "queued", "planned", "failed"].entries()) {
      const key = `target-${index}`;
      pending.run(index + 1, key, "pending");
      target.run(key, status, key, "current-source");
    }
    pending.run(6, null, "pending");
    pending.run(7, "already-delivered", "sent");
    // WS06-B01/A01: recurring content and source-less legacy rows cannot inherit another source's final.
    pending.run(8, "recurring-body", "pending");
    target.run("prior-terminal", "sent", "recurring-body", "prior-source");
    pending.run(9, "legacy-body", "pending");
    sqlite.prepare("UPDATE telegram_pending_alerts SET source_event_id = NULL WHERE id = 9").run();
    target.run("legacy-terminal", "expired", "legacy-body", "prior-source");

    expect(sqlite.prepare(claimCheck.sql).all(...claimCheck.binds)).toEqual([
      { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }, { id: 8 }, { id: 9 },
    ]);
    expect(evaluateQueryPlan(claimCheck, sqlite.prepare(`EXPLAIN QUERY PLAN ${claimCheck.sql}`)
      .all(...claimCheck.binds).map((row) => String(row.detail))).status).toBe("ok");
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

  it("budgets exact production status SQL and follows runtime reader edits", () => {
    const source = readFileSync(resolve("worker/src/telegram/store/usage-analytics.ts"), "utf8");
    const queries = extractProductionStatusSql(source);
    const readers: Record<string, string> = {
      "pulse-aggregate": "computeTelegramCurrentLifecycleSnapshot",
      "status-top-stablecoins": "loadTelegramTopFollowedCoins",
      "status-preset-followers": "loadActivePresetFollowerRows",
      "status-pending-deliveries": "loadPendingDeliveryCount",
      "status-lifecycle-events": "loadLifecycleEventCounts",
      "lifecycle-snapshot-history": "loadTelegramLifecycleHistory",
    };
    for (const check of buildQueryPlanChecks().filter((check) => check.budget != null)) {
      expect(check.sql).toBe(queries.get(readers[check.id]));
    }
    expect(buildQueryPlanChecks().find((check) => check.id === "status-pending-deliveries")?.binds)
      .toEqual(["pending"]);
    const mutated = extractProductionStatusSql(source.replace(
      "SELECT stablecoin_id, COUNT(DISTINCT chat_id) AS subscribers",
      "SELECT stablecoin_id, COUNT(DISTINCT chat_id) + 1 AS subscribers",
    ));
    expect(mutated.get("loadTelegramTopFollowedCoins")).not.toBe(queries.get("loadTelegramTopFollowedCoins"));
    expect(queries.get("computeTelegramCurrentLifecycleSnapshot")).toContain("quiet_hours_enabled_chats");
    expect(queries.get("loadTelegramLifecycleHistory")).toContain("telegram_watcher_lifecycle_daily");
    expect(buildQueryPlanChecks().map((check) => check.id)).not.toContain("lifecycle-current-active-history");
  });

  it("selects the load guard when production status readers or their predicates change", () => {
    expect(hasTelegramLoadGuardImpact(["worker/src/telegram/store/usage-analytics.ts"])).toBe(true);
    expect(hasTelegramLoadGuardImpact(["shared/lib/telegram-alert-families.ts"])).toBe(true);
  });

  it.each([
    "worker/src/cron/telegram/dispatch/dispatch-telegram-alerts.ts",
    "worker/src/cron/telegram/sources/dispatch-telegram-events.ts",
    "worker/src/cron/telegram/delivery/drain.ts",
    "worker/src/cron/telegram/target-plans/telegram-alert-target-plan-contract.ts",
  ])("selects the load guard for relocated cron source %s", (source) => {
    expect(hasTelegramLoadGuardImpact([source])).toBe(true);
  });

  it("defines a reviewed budget for every status read path", () => {
    const statusPathChecks = buildQueryPlanChecks().filter(
      (check) => check.category === "pulse-status" || check.category === "lifecycle",
    );

    expect(statusPathChecks.map((check) => check.id)).toEqual([
      "pulse-aggregate",
      "status-top-stablecoins",
      "status-preset-followers",
      "status-pending-deliveries",
      "status-lifecycle-events",
      "lifecycle-snapshot-history",
    ]);
    for (const check of statusPathChecks) {
      expect(check.budget?.rowsReadTables.length).toBeGreaterThan(0);
      expect(check.budget?.maxRowsRead).toBeGreaterThan(0);
      expect(check.budget?.maxDurationMs).toBeGreaterThan(0);
      if (check.id === "pulse-aggregate" || check.id === "status-preset-followers") {
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
      .sort((a, b) => String(a.stablecoin_id).localeCompare(String(b.stablecoin_id)))).toEqual([
      { stablecoin_id: "coin-a", subscribers: 2 },
      { stablecoin_id: "coin-b", subscribers: 1 },
    ]);
    const presetCheck = buildQueryPlanChecks().find((candidate) => candidate.id === "status-preset-followers")!;
    expect(sqlite.prepare(presetCheck.sql).all(...presetCheck.binds)
      .sort((a, b) => String(a.preset_id).localeCompare(String(b.preset_id)))).toEqual([
      { preset_id: "preset-a", followers: 2 },
      { preset_id: "preset-b", followers: 1 },
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
      "status-preset-followers",
      "status-pending-deliveries",
      "status-lifecycle-events",
      "lifecycle-snapshot-history",
    ]);
    for (const result of results) {
      expect(result.status).toBe("ok");
      expect(result.targetActiveWatchers).toBe(5_000);
      expect(result.rowsRead).toBe(
        Object.values(result.seededRowCounts).reduce((sum, count) => sum + count, 0),
      );
      expect(result.rowsRead).toBeGreaterThan(0);
      expect(result.durationMs).toBeLessThanOrEqual(result.maxDurationMs);
    }
  });
});
