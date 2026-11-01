import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyReserveCompositionOverview } from "@shared/types/live-reserves";

const mocks = vi.hoisted(() => ({
  drift: vi.fn(),
  overview: vi.fn(),
  maxAge: vi.fn(),
  states: vi.fn(),
  acknowledged: vi.fn(),
  scoringEvidence: vi.fn(),
}));
const cache = vi.hoisted(() => new Map<string, string>());

vi.mock("../../lib/collateral-drift", () => ({ checkCollateralDrift: mocks.drift }));
vi.mock("../../lib/live-reserves/store", () => ({
  computeReserveCompositionOverview: mocks.overview,
  getMaxSyncAge: mocks.maxAge,
  loadReserveSyncStateMap: mocks.states,
  loadPublishedReserveScoringEvidence: mocks.scoringEvidence,
}));
vi.mock("../../lib/reserve-feed-reviews", () => ({
  resolveAcknowledgedReserveFeedIds: mocks.acknowledged,
}));
vi.mock("../../lib/db-cache", () => ({
  getCache: vi.fn(async (_db: D1Database, key: string) =>
    cache.has(key) ? { value: cache.get(key)!, updatedAt: 0 } : null),
  setCache: vi.fn(async (_db: D1Database, key: string, value: string) => {
    cache.set(key, value);
  }),
}));

import {
  evaluateReserveAdapterAlerts,
  runReservePostSyncWatchdog,
  type ReserveAdapterAlertAttempt,
  type ReserveAdapterAlertState,
} from "../reserve-post-sync-watchdog";

const COIN = "iusd-infinifi";
const NOW = 1_000_000;

function attempt(overrides: Partial<ReserveAdapterAlertAttempt> & { attemptedAt: number }): ReserveAdapterAlertAttempt {
  return {
    status: "error",
    failureCategory: "upstream-http",
    sourceTimestamp: null,
    freshnessMode: null,
    ...overrides,
  };
}

function evaluate(
  attempts: ReserveAdapterAlertAttempt[],
  options: {
    prior?: ReserveAdapterAlertState;
    acknowledged?: string[];
    budget?: number;
    nowSec?: number;
    scoreIneligible?: boolean;
    scoreIneligibleUnknown?: boolean;
  } = {},
) {
  return evaluateReserveAdapterAlerts({
    nowSec: options.nowSec ?? NOW,
    attemptsByCoin: new Map([[COIN, attempts]]),
    sourceAgeBudgetByCoin: new Map([[COIN, options.budget ?? 7_200]]),
    scoreIneligibleCoinIds: new Set(options.scoreIneligible === false ? [] : [COIN]),
    scoreIneligibleUnknownCoinIds: new Set(options.scoreIneligibleUnknown ? [COIN] : []),
    acknowledgedCoinIds: new Set(options.acknowledged ?? []),
    previous: options.prior ?? { version: 1, coins: {} },
  });
}

describe("evaluateReserveAdapterAlerts", () => {
  it("raises the failure rule at the third consecutive failed cycle, not before", () => {
    const two = evaluate([
      attempt({ attemptedAt: NOW - 14_400 }),
      attempt({ attemptedAt: NOW - 28_800 }),
    ]);
    expect(two.raised).toEqual([]);
    expect(two.state.coins[COIN] ?? null).toBeNull();

    const three = evaluate([
      attempt({ attemptedAt: NOW }),
      attempt({ attemptedAt: NOW - 14_400 }),
      attempt({ attemptedAt: NOW - 28_800 }),
    ]);
    expect(three.raised).toEqual(["reserve-adapter-failure-sustained"]);
    expect(three.failedSources).toEqual([{ stablecoinId: COIN, failedCycles: 3 }]);
    expect(three.state.coins[COIN]).toEqual({ failureRaised: true, scoreIneligibleRaised: false, clockRaised: false });
  });

  it("does not re-raise a sustained failure and recovers exactly once", () => {
    const prior: ReserveAdapterAlertState = {
      version: 1,
      coins: { [COIN]: { failureRaised: true, scoreIneligibleRaised: false, clockRaised: false } },
    };
    const stillFailing = evaluate([
      attempt({ attemptedAt: NOW }),
      attempt({ attemptedAt: NOW - 14_400 }),
      attempt({ attemptedAt: NOW - 28_800 }),
      attempt({ attemptedAt: NOW - 43_200 }),
    ], { prior });
    expect(stillFailing.raised).toEqual([]);
    expect(stillFailing.recovered).toEqual([]);
    expect(stillFailing.state.coins[COIN]?.failureRaised).toBe(true);

    const recovered = evaluate([
      attempt({ attemptedAt: NOW, status: "ok", failureCategory: null }),
    ], { prior: stillFailing.state });
    expect(recovered.recovered).toEqual(["reserve-adapter-failure-sustained"]);
    expect(recovered.state.coins[COIN]).toBeUndefined();

    const afterRecovery = evaluate([
      attempt({ attemptedAt: NOW + 14_400, status: "ok", failureCategory: null }),
    ], { prior: recovered.state });
    expect(afterRecovery.recovered).toEqual([]);
  });

  it("keeps a rule raised while any coin still fails and reports no rule-level recovery", () => {
    const other = "usdc-circle";
    const prior: ReserveAdapterAlertState = {
      version: 1,
      coins: {
        [COIN]: { failureRaised: true, scoreIneligibleRaised: false, clockRaised: false },
        [other]: { failureRaised: true, scoreIneligibleRaised: false, clockRaised: false },
      },
    };
    const result = evaluateReserveAdapterAlerts({
      nowSec: NOW,
      attemptsByCoin: new Map([
        [COIN, [attempt({ attemptedAt: NOW, status: "ok", failureCategory: null })]],
        [other, [
          attempt({ attemptedAt: NOW }),
          attempt({ attemptedAt: NOW - 14_400 }),
          attempt({ attemptedAt: NOW - 28_800 }),
        ]],
      ]),
      sourceAgeBudgetByCoin: new Map([[COIN, 7_200], [other, 7_200]]),
      scoreIneligibleCoinIds: new Set(),
      scoreIneligibleUnknownCoinIds: new Set(),
      acknowledgedCoinIds: new Set(),
      previous: prior,
    });
    expect(result.raised).toEqual([]);
    expect(result.recovered).toEqual([]);
    expect(result.state.coins[other]?.failureRaised).toBe(true);
    expect(result.state.coins[COIN]).toBeUndefined();
  });

  it.each([
    ["error", "upstream-http"],
    ["skipped", "circuit-open"],
  ])("counts %s/%s as a failed cycle", (status, failureCategory) => {
    const result = evaluate([
      attempt({ attemptedAt: NOW, status, failureCategory }),
      attempt({ attemptedAt: NOW - 14_400, status: "error" }),
      attempt({ attemptedAt: NOW - 28_800, status: "skipped", failureCategory: "circuit-open" }),
    ]);
    expect(result.raised).toContain("reserve-adapter-failure-sustained");
  });

  it("does not count a producer budget deferral toward the failure streak", () => {
    const result = evaluate([
      attempt({ attemptedAt: NOW, status: "skipped", failureCategory: "run-budget-exhausted" }),
      attempt({ attemptedAt: NOW - 14_400, status: "error" }),
      attempt({ attemptedAt: NOW - 28_800, status: "error" }),
    ]);
    expect(result.raised).toEqual([]);
    expect(result.failedSources).toEqual([]);
  });

  it("keeps an exact-failure acknowledgement from raising, then raises once it lapses", () => {
    const attempts = [
      attempt({ attemptedAt: NOW }),
      attempt({ attemptedAt: NOW - 14_400 }),
      attempt({ attemptedAt: NOW - 28_800 }),
    ];
    const acknowledged = evaluate(attempts, { acknowledged: [COIN] });
    expect(acknowledged.raised).toEqual([]);
    expect(acknowledged.failedSources).toHaveLength(1);
    expect(acknowledged.state.coins[COIN]).toBeUndefined();

    const lapsed = evaluate(attempts, { prior: acknowledged.state });
    expect(lapsed.raised).toEqual(["reserve-adapter-failure-sustained"]);
  });

  it("never treats an acknowledgement as recovery for an already-raised failure", () => {
    const prior: ReserveAdapterAlertState = {
      version: 1,
      coins: { [COIN]: { failureRaised: true, scoreIneligibleRaised: false, clockRaised: false } },
    };
    const result = evaluate([
      attempt({ attemptedAt: NOW }),
      attempt({ attemptedAt: NOW - 14_400 }),
      attempt({ attemptedAt: NOW - 28_800 }),
    ], { prior, acknowledged: [COIN] });
    expect(result.recovered).toEqual([]);
    expect(result.state.coins[COIN]?.failureRaised).toBe(true);
  });

  it("raises the stalled-clock rule only when a successful verified clock is frozen past its budget", () => {
    const frozen = (sourceTimestamp: number, freshnessMode: string | null = "verified") => [
      attempt({ attemptedAt: NOW, status: "ok", failureCategory: null, sourceTimestamp, freshnessMode }),
      attempt({ attemptedAt: NOW - 14_400, status: "ok", failureCategory: null, sourceTimestamp, freshnessMode }),
    ];

    const stalled = evaluate(frozen(NOW - 101), { budget: 100 });
    expect(stalled.raised).toEqual(["reserve-source-clock-stalled"]);
    expect(stalled.stalledSources).toEqual([{
      stablecoinId: COIN,
      sourceTimestamp: NOW - 101,
      sourceAgeSec: 101,
      sourceAgeBudgetSec: 100,
    }]);

    expect(evaluate(frozen(NOW - 100), { budget: 100 }).raised).toEqual([]);
    expect(evaluate([
      attempt({ attemptedAt: NOW, status: "ok", failureCategory: null, sourceTimestamp: NOW - 500 }),
      attempt({ attemptedAt: NOW - 14_400, status: "ok", failureCategory: null, sourceTimestamp: NOW - 900 }),
    ], { budget: 100 }).raised).toEqual([]);
    expect(evaluate(frozen(NOW - 500, "unverified"), { budget: 100 }).raised).toEqual([]);
    expect(evaluate([
      attempt({ attemptedAt: NOW, status: "error", sourceTimestamp: NOW - 500 }),
      attempt({ attemptedAt: NOW - 14_400, status: "ok", failureCategory: null, sourceTimestamp: NOW - 500 }),
      attempt({ attemptedAt: NOW - 28_800, status: "ok", failureCategory: null, sourceTimestamp: NOW - 500 }),
    ], { budget: 100 }).raised).toEqual([]);
  });

  it("raises the score-ineligible rule at the third consecutive degraded success, not before", () => {
    const degraded = (attemptedAt: number) =>
      attempt({ attemptedAt, status: "degraded", failureCategory: null });
    const two = evaluate([degraded(NOW), degraded(NOW - 14_400)]);
    expect(two.raised).toEqual([]);
    expect(two.state.coins[COIN] ?? null).toBeNull();

    const three = evaluate([degraded(NOW), degraded(NOW - 14_400), degraded(NOW - 28_800)]);
    expect(three.raised).toEqual(["reserve-score-ineligible-sustained"]);
    expect(three.scoreIneligibleSources).toEqual([{ stablecoinId: COIN, degradedCycles: 3 }]);
    expect(three.state.coins[COIN]).toMatchObject({ scoreIneligibleRaised: true });

    const recovered = evaluate([attempt({ attemptedAt: NOW + 14_400, status: "ok", failureCategory: null })],
      { prior: three.state, scoreIneligible: false });
    expect(recovered.recovered).toEqual(["reserve-score-ineligible-sustained"]);
    expect(recovered.scoreIneligibleSources).toEqual([]);
  });

  it("does not count a degraded attempt that wrote no snapshot toward the streak", () => {
    // A withheld fallback records `degraded` with a failure category and leaves
    // the retained snapshot untouched; it is not a degraded success.
    const withheld = (attemptedAt: number) =>
      attempt({ attemptedAt, status: "degraded", failureCategory: "upstream-http" });
    const result = evaluate([withheld(NOW), withheld(NOW - 14_400), withheld(NOW - 28_800)]);
    expect(result.raised).toEqual([]);
    expect(result.scoreIneligibleSources).toEqual([]);
    expect(result.state.coins[COIN] ?? null).toBeNull();
  });

  it("holds a raised score-ineligible alert while an interrupted streak still publishes ineligible evidence", () => {
    const prior: ReserveAdapterAlertState = {
      version: 1,
      coins: { [COIN]: { failureRaised: false, scoreIneligibleRaised: true, clockRaised: false } },
    };
    const result = evaluate([attempt({ attemptedAt: NOW, status: "error" })], { prior });
    expect(result.raised).toEqual([]);
    expect(result.recovered).toEqual([]);
    expect(result.state.coins[COIN]?.scoreIneligibleRaised).toBe(true);
  });

  it("holds a raised score-ineligible alert while the published evidence is unreadable", () => {
    const prior: ReserveAdapterAlertState = {
      version: 1,
      coins: { [COIN]: { failureRaised: false, scoreIneligibleRaised: true, clockRaised: false } },
    };
    const result = evaluate([attempt({ attemptedAt: NOW, status: "ok", failureCategory: null })],
      { prior, scoreIneligible: false, scoreIneligibleUnknown: true });
    expect(result.raised).toEqual([]);
    expect(result.recovered).toEqual([]);
    expect(result.state.coins[COIN]?.scoreIneligibleRaised).toBe(true);
    expect(result.scoreIneligibleUnknownSources).toEqual([{ stablecoinId: COIN, heldRaised: true }]);
  });

  it("does not call a degraded success score-ineligible without a scoring-degraded warning", () => {
    const degraded = (attemptedAt: number) =>
      attempt({ attemptedAt, status: "degraded", failureCategory: null });
    const result = evaluate([degraded(NOW), degraded(NOW - 14_400), degraded(NOW - 28_800)],
      { scoreIneligible: false });
    expect(result.raised).toEqual([]);
    expect(result.scoreIneligibleSources).toEqual([]);
  });

  it("does not count an interrupted degraded streak", () => {
    const result = evaluate([
      attempt({ attemptedAt: NOW, status: "degraded", failureCategory: null }),
      attempt({ attemptedAt: NOW - 14_400, status: "ok", failureCategory: null }),
      attempt({ attemptedAt: NOW - 28_800, status: "degraded", failureCategory: null }),
    ]);
    expect(result.raised).toEqual([]);
    expect(result.scoreIneligibleSources).toEqual([]);
  });

  it("recovers the stalled-clock rule once the clock advances", () => {
    const prior: ReserveAdapterAlertState = {
      version: 1,
      coins: { [COIN]: { failureRaised: false, scoreIneligibleRaised: false, clockRaised: true } },
    };
    const advanced = evaluate([
      attempt({ attemptedAt: NOW, status: "ok", failureCategory: null, sourceTimestamp: NOW - 10 }),
      attempt({ attemptedAt: NOW - 14_400, status: "ok", failureCategory: null, sourceTimestamp: NOW - 500 }),
    ], { prior, budget: 100 });
    expect(advanced.recovered).toEqual(["reserve-source-clock-stalled"]);
    expect(advanced.state.coins[COIN]).toBeUndefined();
  });
});

describe("runReservePostSyncWatchdog reserve adapter alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cache.clear();
    mocks.drift.mockResolvedValue({
      driftCoins: [], fallbackCoins: [], observedIds: [], liveReserveMap: new Map(),
    });
    mocks.overview.mockResolvedValue({ ...emptyReserveCompositionOverview() });
    mocks.maxAge.mockResolvedValue(0);
    mocks.states.mockResolvedValue(new Map([[COIN, { lastStatus: "error" }]]));
    mocks.acknowledged.mockResolvedValue(new Set<string>());
    mocks.scoringEvidence.mockResolvedValue({
      scoreIneligibleIds: new Set<string>(),
      unknownIds: new Set<string>(),
    });
  });

  function historyDb(rows: Array<Record<string, unknown>>): D1Database {
    return {
      prepare: () => ({ bind: () => ({ all: async () => ({ results: rows, success: true, meta: {} }) }) }),
    } as unknown as D1Database;
  }

  function historyRow(attemptedAt: number, status: string) {
    return {
      stablecoin_id: COIN,
      attempted_at: attemptedAt,
      status,
      // Only failures carry a failure category; a degraded success wrote a snapshot.
      failure_category: status === "skipped" ? "circuit-open" : status === "error" ? "upstream-http" : null,
      source_timestamp: null,
      freshness_mode: null,
    };
  }

  async function readAlert(rows: Array<Record<string, unknown>>) {
    const result = await runReservePostSyncWatchdog(historyDb(rows));
    return JSON.parse(result.metadata ?? "{}") as {
      firedRuleIds: string[];
      degradedReasons: string[];
      activeAdapterAlertReasons: string[];
      quality?: { reason?: string; reasons: string[] };
      compositionCensus: { observedCoins: number; findings: Array<Record<string, unknown>> } | null;
      reserveAdapterAlert: {
        raised: string[];
        recovered: string[];
        failedSources: Array<{ stablecoinId: string; failedCycles: number }>;
        scoreIneligibleSources: Array<{ stablecoinId: string; degradedCycles: number }>;
        scoreIneligibleUnknownSources: Array<{ stablecoinId: string; heldRaised: boolean }>;
      } | null;
    };
  }

  it("fires once at the third cycle and recovers once when a cycle succeeds", async () => {
    const second = await readAlert([historyRow(NOW - 14_400, "error"), historyRow(NOW - 28_800, "error")]);
    expect(second.reserveAdapterAlert?.raised).toEqual([]);
    expect(second.firedRuleIds).not.toContain("reserve-adapter-failure-sustained");

    const third = await readAlert([
      historyRow(NOW, "error"), historyRow(NOW - 14_400, "error"), historyRow(NOW - 28_800, "error"),
    ]);
    expect(third.reserveAdapterAlert?.raised).toEqual(["reserve-adapter-failure-sustained"]);
    expect(third.firedRuleIds).toContain("reserve-adapter-failure-sustained");

    const fourth = await readAlert([
      historyRow(NOW + 14_400, "error"), historyRow(NOW, "error"),
      historyRow(NOW - 14_400, "error"), historyRow(NOW - 28_800, "error"),
    ]);
    expect(fourth.reserveAdapterAlert?.raised).toEqual([]);
    expect(fourth.reserveAdapterAlert?.failedSources).toEqual([{ stablecoinId: COIN, failedCycles: 4 }]);
    expect(fourth.firedRuleIds).toContain("reserve-adapter-failure-sustained");

    const recovered = await readAlert([historyRow(NOW + 28_800, "ok")]);
    expect(recovered.reserveAdapterAlert?.recovered).toEqual(["reserve-adapter-failure-sustained"]);
    expect(recovered.firedRuleIds).not.toContain("reserve-adapter-failure-sustained");
  });

  it("degrades the reserve source with machine reasons while an adapter alert is active", async () => {
    const result = await runReservePostSyncWatchdog(historyDb([
      historyRow(NOW, "error"), historyRow(NOW - 14_400, "error"), historyRow(NOW - 28_800, "error"),
    ]));
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(result.status).toBe("degraded");
    expect(metadata.reason).toBe("reserve-adapter-alert-raised");
    expect(metadata.degradedReasons).toContain("reserve-adapter-alert-raised");
    // One quality object carries the per-coin transition and the fired rule ids;
    // the adapter rule is not repeated as a bare id next to its per-coin reason.
    expect(metadata.quality).toEqual({
      reason: "reserve-adapter-alert-raised",
      reasons: ["reserve-adapter-failure-sustained:iusd-infinifi", "reserve-sync-degraded"],
    });
    expect(metadata.activeAdapterAlertReasons).toEqual(["reserve-adapter-failure-sustained:iusd-infinifi"]);
  });

  it("keeps an acknowledged adapter failure out of the status cause", async () => {
    mocks.acknowledged.mockResolvedValue(new Set([COIN]));
    const result = await runReservePostSyncWatchdog(historyDb([
      historyRow(NOW, "error"), historyRow(NOW - 14_400, "error"), historyRow(NOW - 28_800, "error"),
    ]));
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(result.status).toBe("ok");
    // The acknowledged adapter transition contributes no quality reason; the
    // independently fired `reserve-sync-degraded` finding still does (union).
    expect(metadata.quality?.reason).toBeUndefined();
    expect(metadata.quality?.reasons).toEqual(["reserve-sync-degraded"]);
    expect(metadata.activeAdapterAlertReasons).toEqual([]);
  });

  it("publishes fired findings as operator quality reasons", async () => {
    mocks.states.mockResolvedValue(new Map([[COIN, { lastStatus: "ok" }]]));
    const clean = await readAlert([]);
    expect(clean.firedRuleIds).toEqual([]);
    expect(clean.quality).toBeUndefined();

    mocks.states.mockResolvedValue(new Map([[COIN, { lastStatus: "degraded" }]]));
    mocks.scoringEvidence.mockResolvedValue({
      scoreIneligibleIds: new Set([COIN]),
      unknownIds: new Set<string>(),
    });
    const failing = await readAlert([
      historyRow(NOW, "degraded"), historyRow(NOW - 14_400, "degraded"), historyRow(NOW - 28_800, "degraded"),
    ]);
    expect(failing.reserveAdapterAlert?.scoreIneligibleSources).toEqual([
      { stablecoinId: COIN, degradedCycles: 3 },
    ]);
    expect(failing.firedRuleIds).toEqual(expect.arrayContaining([
      "reserve-sync-degraded",
      "reserve-score-ineligible-sustained",
    ]));
    // The active transition is named per coin, so the bare rule id is not repeated.
    expect(failing.quality?.reasons).toEqual([
      "reserve-score-ineligible-sustained:iusd-infinifi",
      "reserve-sync-degraded",
    ]);
    expect(failing.activeAdapterAlertReasons).toEqual(["reserve-score-ineligible-sustained:iusd-infinifi"]);
  });

  it("does not charge a degraded attempt that wrote no snapshot as a degraded success", async () => {
    mocks.states.mockResolvedValue(new Map([[COIN, { lastStatus: "degraded" }]]));
    mocks.scoringEvidence.mockResolvedValue({
      scoreIneligibleIds: new Set([COIN]),
      unknownIds: new Set<string>(),
    });
    const withheld = (attemptedAt: number) => ({
      ...historyRow(attemptedAt, "degraded"),
      failure_category: "upstream-http",
    });
    const result = await readAlert([withheld(NOW), withheld(NOW - 14_400), withheld(NOW - 28_800)]);
    expect(result.reserveAdapterAlert?.raised).toEqual([]);
    expect(result.reserveAdapterAlert?.scoreIneligibleSources).toEqual([]);
  });

  it("holds a raised score-ineligible alert when the published snapshot becomes unreadable", async () => {
    mocks.states.mockResolvedValue(new Map([[COIN, { lastStatus: "degraded" }]]));
    mocks.scoringEvidence.mockResolvedValue({
      scoreIneligibleIds: new Set([COIN]),
      unknownIds: new Set<string>(),
    });
    const raised = await readAlert([
      historyRow(NOW, "degraded"), historyRow(NOW - 14_400, "degraded"), historyRow(NOW - 28_800, "degraded"),
    ]);
    expect(raised.reserveAdapterAlert?.raised).toEqual(["reserve-score-ineligible-sustained"]);

    mocks.scoringEvidence.mockResolvedValue({
      scoreIneligibleIds: new Set<string>(),
      unknownIds: new Set([COIN]),
    });
    const held = await readAlert([historyRow(NOW + 14_400, "error")]);
    expect(held.reserveAdapterAlert?.recovered).toEqual([]);
    expect(held.reserveAdapterAlert?.scoreIneligibleUnknownSources).toEqual([
      { stablecoinId: COIN, heldRaised: true },
    ]);
    expect(held.firedRuleIds).toContain("reserve-score-ineligible-sustained");
    expect(held.degradedReasons).toContain("reserve-score-ineligible-evidence-unknown");
  });

  it("raises the census rule when a published composition changes shape", async () => {
    // A configured state map makes the adapter stage run; this test only reads the census stage.
    mocks.states.mockResolvedValue(new Map());
    const slices = (names: Array<[string, number]>) =>
      names.map(([name, pct]) => ({ name, pct, risk: "low" as const }));
    const first = await (async () => {
      mocks.drift.mockResolvedValue({
        driftCoins: [], fallbackCoins: [], observedIds: [],
        liveReserveMap: new Map([[COIN, slices([["T-bills", 60], ["Custody cash", 40]])]]),
      });
      return readAlert([]);
    })();
    expect(first.firedRuleIds).not.toContain("reserve-composition-census-drift");
    expect(first.compositionCensus).toEqual({ observedCoins: 1, findings: [] });

    mocks.drift.mockResolvedValue({
      driftCoins: [], fallbackCoins: [], observedIds: [],
      liveReserveMap: new Map([[COIN, slices([["T-bills", 30], ["Custody cash", 40], ["Repo", 30]])]]),
    });
    const second = await readAlert([]);
    expect(second.compositionCensus?.findings).toEqual([expect.objectContaining({
      stablecoinId: COIN, added: ["Repo"], removed: [], shareDriftPct: 30,
    })]);
    expect(second.firedRuleIds).toContain("reserve-composition-census-drift");
    expect(second.quality?.reasons).toContain("reserve-composition-census-drift");
  });

  it("reports an unreadable retained census instead of silently reseeding a clean baseline", async () => {
    mocks.states.mockResolvedValue(new Map());
    const slices = (names: Array<[string, number]>) =>
      names.map(([name, pct]) => ({ name, pct, risk: "low" as const }));
    mocks.drift.mockResolvedValue({
      driftCoins: [], fallbackCoins: [], observedIds: [],
      liveReserveMap: new Map([[COIN, slices([["T-bills", 60], ["Custody cash", 40]])]]),
    });
    cache.set("reserve-post-sync-watchdog:composition-census:v1", "{not-json");

    const corrupt = await readAlert([]);
    expect(corrupt.degradedReasons).toContain("composition-census-state-unreadable");
    expect(corrupt.compositionCensus).toBeNull();
    expect(corrupt.firedRuleIds).not.toContain("reserve-composition-census-drift");

    // The reseeded baseline serves the next run; this run published no verdict.
    const next = await readAlert([]);
    expect(next.compositionCensus).toEqual({ observedCoins: 1, findings: [] });
    expect(next.degradedReasons).not.toContain("composition-census-state-unreadable");
  });
});
