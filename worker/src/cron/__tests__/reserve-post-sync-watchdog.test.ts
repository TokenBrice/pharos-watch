import { beforeEach, describe, expect, it, vi } from "vitest";
import { CRON_INTERVALS } from "@shared/lib/cron-jobs";
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
vi.mock("../sync-live-reserves-shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sync-live-reserves-shared")>();
  return { ...actual, SYNC_ORDERED_CONFIGURED_COINS: actual.SYNC_ORDERED_CONFIGURED_COINS.filter((coin) => coin.id === "iusd-infinifi") };
});
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
import { SNAPSHOT_KEYS } from "../telegram/sources/telegram-alert-snapshots";
import { SYNC_ORDERED_CONFIGURED_COINS } from "../sync-live-reserves-shared";

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

const cycleTimes = [NOW, NOW - 14_400, NOW - 28_800];
const failureState = { failureRaised: true, scoreIneligibleRaised: false, clockRaised: false };
const scoreState = { failureRaised: false, scoreIneligibleRaised: true, clockRaised: false };
const priorState = (state: ReserveAdapterAlertState["coins"][string]): ReserveAdapterAlertState =>
  ({ version: 1, coins: { [COIN]: state } });
const failedAttempts = () => cycleTimes.map(attemptedAt => attempt({ attemptedAt }));
const degraded = (attemptedAt: number) => attempt({ attemptedAt, status: "degraded", failureCategory: null });
const scoringEvidence = (scoreIneligibleIds: string[] = [], unknownIds: string[] = []) => ({
  structuralOnlyIds: new Set<string>(), scoreIneligibleIds: new Set(scoreIneligibleIds), unknownIds: new Set(unknownIds),
});
const emptyDrift = () => ({ driftCoins: [], fallbackCoins: [], observedIds: [], liveReserveMap: new Map() });

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

    const three = evaluate(failedAttempts());
    expect(three.raised).toEqual(["reserve-adapter-failure-sustained"]);
    expect(three.failedSources).toEqual([{ stablecoinId: COIN, failedCycles: 3 }]);
    expect(three.state.coins[COIN]).toEqual(failureState);
  });

  it("does not re-raise a sustained failure and recovers exactly once", () => {
    const prior = priorState(failureState);
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
        [COIN]: failureState,
        [other]: failureState,
      },
    };
    const result = evaluateReserveAdapterAlerts({
      nowSec: NOW,
      attemptsByCoin: new Map([
        [COIN, [attempt({ attemptedAt: NOW, status: "ok", failureCategory: null })]],
        [other, failedAttempts()],
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
    const attempts = failedAttempts();
    const acknowledged = evaluate(attempts, { acknowledged: [COIN] });
    expect(acknowledged.raised).toEqual([]);
    expect(acknowledged.failedSources).toHaveLength(1);
    expect(acknowledged.state.coins[COIN]).toBeUndefined();

    const lapsed = evaluate(attempts, { prior: acknowledged.state });
    expect(lapsed.raised).toEqual(["reserve-adapter-failure-sustained"]);
  });

  it("never treats an acknowledgement as recovery for an already-raised failure", () => {
    const prior = priorState(failureState);
    const result = evaluate(failedAttempts(), { prior, acknowledged: [COIN] });
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
    const two = evaluate([degraded(NOW), degraded(NOW - 14_400)]);
    expect(two.raised).toEqual([]);
    expect(two.state.coins[COIN] ?? null).toBeNull();

    const three = evaluate(cycleTimes.map(degraded));
    expect(three.raised).toEqual(["reserve-score-ineligible-sustained"]);
    expect(three.scoreIneligibleSources).toEqual([{ stablecoinId: COIN, degradedCycles: 3 }]);
    expect(three.state.coins[COIN]).toMatchObject({ scoreIneligibleRaised: true });

    const recovered = evaluate([attempt({ attemptedAt: NOW + 14_400, status: "ok", failureCategory: null })],
      { prior: three.state, scoreIneligible: false });
    expect(recovered.recovered).toEqual(["reserve-score-ineligible-sustained"]);
    expect(recovered.scoreIneligibleSources).toEqual([]);
  });

  it("does not count a degraded attempt that wrote no snapshot toward the streak", () => {
    const withheld = (attemptedAt: number) =>
      attempt({ attemptedAt, status: "degraded", failureCategory: "upstream-http" });
    const result = evaluate(cycleTimes.map(withheld));
    expect(result.raised).toEqual([]);
    expect(result.scoreIneligibleSources).toEqual([]);
    expect(result.state.coins[COIN] ?? null).toBeNull();
  });

  it("holds a raised score-ineligible alert while an interrupted streak still publishes ineligible evidence", () => {
    const prior = priorState(scoreState);
    const result = evaluate([attempt({ attemptedAt: NOW, status: "error" })], { prior });
    expect(result.raised).toEqual([]);
    expect(result.recovered).toEqual([]);
    expect(result.state.coins[COIN]?.scoreIneligibleRaised).toBe(true);
  });

  it("holds a raised score-ineligible alert while the published evidence is unreadable", () => {
    const prior = priorState(scoreState);
    const result = evaluate([attempt({ attemptedAt: NOW, status: "ok", failureCategory: null })],
      { prior, scoreIneligible: false, scoreIneligibleUnknown: true });
    expect(result.raised).toEqual([]);
    expect(result.recovered).toEqual([]);
    expect(result.state.coins[COIN]?.scoreIneligibleRaised).toBe(true);
    expect(result.scoreIneligibleUnknownSources).toEqual([{ stablecoinId: COIN, heldRaised: true }]);
  });

  it("does not call a degraded success score-ineligible without a scoring-degraded warning", () => {
    const result = evaluate(cycleTimes.map(degraded),
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
    SYNC_ORDERED_CONFIGURED_COINS.splice(1);
    cache.clear();
    mocks.drift.mockResolvedValue(emptyDrift());
    mocks.overview.mockResolvedValue({ ...emptyReserveCompositionOverview() });
    mocks.maxAge.mockResolvedValue(0);
    mocks.states.mockResolvedValue(new Map([[COIN, { lastStatus: "error" }]]));
    mocks.acknowledged.mockResolvedValue(new Set<string>());
    mocks.scoringEvidence.mockResolvedValue(scoringEvidence());
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

  const historyRows = (status: string) => cycleTimes.map(at => historyRow(at, status));
  const composition = (names: Array<[string, number]>) => ({
    ...emptyDrift(), liveReserveMap: new Map([[COIN, names.map(([name, pct]) => ({ name, pct, risk: "low" as const }))]]),
  });

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

  it("publishes an explicit non-continuous gap for an empty observed census so recovery cold-seeds", async () => {
    const interval = CRON_INTERVALS["sync-live-reserves"];
    const t0 = NOW;
    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(t0 * 1000);
      mocks.drift.mockResolvedValue({ ...emptyDrift(), observedIds: [COIN] });
      await runReservePostSyncWatchdog(historyDb([]));
      expect(mocks.overview.mock.calls[0].slice(3)).toEqual([undefined, { adapterReliability: false }]);
      const healthy = JSON.parse(cache.get(SNAPSHOT_KEYS.reserve)!) as { observedSince: Record<string, number> };
      expect(healthy.observedSince[COIN]).toBe(t0);

      nowSpy.mockReturnValue((t0 + interval) * 1000);
      mocks.drift.mockResolvedValue({ ...emptyDrift(), fallbackCoins: [COIN] });
      const gapResult = await runReservePostSyncWatchdog(historyDb([]));
      const gapMetadata = JSON.parse(gapResult.metadata ?? "{}") as { degradedReasons: string[] };
      expect(gapMetadata.degradedReasons).toContain("reserve-drift-census-empty");

      const gap = JSON.parse(cache.get(SNAPSHOT_KEYS.reserve)!) as Record<string, unknown>;
      expect(gap).toMatchObject({
        continuous: false,
        driftIds: [],
        unavailableIds: [COIN],
        publishedAt: t0 + interval,
      });
      // toMatchObject treats {} as a wildcard; the gap must carry no epochs.
      expect(gap.observedSince).toEqual({});

      nowSpy.mockReturnValue((t0 + 2 * interval) * 1000);
      mocks.drift.mockResolvedValue({
        ...emptyDrift(), observedIds: [COIN],
        driftCoins: [{ id: COIN, liveScore: 40, curatedScore: 60, delta: 20 }],
      });
      await runReservePostSyncWatchdog(historyDb([]));
      const recovery = JSON.parse(cache.get(SNAPSHOT_KEYS.reserve)!) as { observedSince: Record<string, number> };
      expect(recovery.observedSince[COIN]).toBe(t0 + 2 * interval);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.each([false, true])("fires once at the third cycle and recovers once (legacy=%s)", async (legacy) => {
    const second = await readAlert([historyRow(NOW - 14_400, "error"), historyRow(NOW - 28_800, "error")]);
    expect(second.reserveAdapterAlert?.raised).toEqual([]);
    expect(second.firedRuleIds).not.toContain("reserve-adapter-failure-sustained");

    const third = await readAlert(historyRows("error"));
    expect(third.reserveAdapterAlert?.raised).toEqual(["reserve-adapter-failure-sustained"]);
    expect(third.firedRuleIds).toContain("reserve-adapter-failure-sustained");
    if (legacy) cache.set("reserve-post-sync-watchdog:adapter-alerts:v1", JSON.stringify({
      version: 1, coins: { [COIN]: { failureRaised: true, clockRaised: false } },
    }));

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

  it.each([
    "{not-json", "", "null", '{"version":2,"coins":{}}', '{"version":1,"coins":[]}',
    JSON.stringify({ version: 1, coins: { [COIN]: null } }),
    JSON.stringify({ version: 1, coins: { [COIN]: { ...failureState, failureRaised: 1 } } }),
    JSON.stringify({ version: 1, coins: { [COIN]: { ...failureState, scoreIneligibleRaised: null } } }),
  ])("suppresses transitions against unreadable adapter state %s and reseeds the next run", async (value) => {
    cache.set("reserve-post-sync-watchdog:adapter-alerts:v1", value);
    const corrupt = await readAlert(historyRows("error"));
    expect(corrupt.degradedReasons).toContain("reserve-adapter-alert-evidence-read-failed");
    expect(corrupt.reserveAdapterAlert).toBeNull();
    expect(corrupt.activeAdapterAlertReasons).toEqual([]);
    expect(corrupt.firedRuleIds).not.toContain("reserve-adapter-failure-sustained");
    expect(JSON.parse(cache.get("reserve-post-sync-watchdog:adapter-alerts:v1")!)).toEqual(priorState(failureState));
    const next = await readAlert(historyRows("error"));
    expect(next.reserveAdapterAlert?.raised).toEqual([]);
    expect(next.reserveAdapterAlert?.recovered).toEqual([]);
    expect(next.degradedReasons).not.toContain("reserve-adapter-alert-evidence-read-failed");
  });

  it("degrades the reserve source with machine reasons while an adapter alert is active", async () => {
    const result = await runReservePostSyncWatchdog(historyDb(historyRows("error")));
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(result.status).toBe("degraded");
    expect(metadata.reason).toBe("reserve-adapter-alert-raised");
    expect(metadata.degradedReasons).toContain("reserve-adapter-alert-raised");
    expect(metadata.quality).toEqual({
      reason: "reserve-adapter-alert-raised",
      reasons: ["reserve-adapter-failure-sustained:iusd-infinifi", "reserve-sync-degraded"],
    });
    expect(metadata.activeAdapterAlertReasons).toEqual(["reserve-adapter-failure-sustained:iusd-infinifi"]);
  });

  it("keeps an acknowledged adapter failure out of the status cause", async () => {
    const rows = historyRows("error");
    await readAlert(rows);
    mocks.acknowledged.mockResolvedValue(new Set([COIN]));
    const result = await runReservePostSyncWatchdog(historyDb(rows));
    const metadata = JSON.parse(result.metadata ?? "{}");
    expect(result.status).toBe("ok");
    expect(metadata.quality?.reason).toBeUndefined();
    expect(metadata.quality?.reasons).toEqual(["reserve-sync-degraded"]);
    expect(metadata.activeAdapterAlertReasons).toEqual([]);
    expect(metadata.reserveAdapterAlert.recovered).toEqual([]);
    mocks.acknowledged.mockResolvedValue(new Set());
    expect((await readAlert(rows)).activeAdapterAlertReasons).toEqual([`reserve-adapter-failure-sustained:${COIN}`]);
  });

  it("keeps structural findings as quality while mixed, unknown or stalled findings still degrade", async () => {
    mocks.states.mockResolvedValue(new Map([[COIN, { lastStatus: "ok" }]]));
    expect((await readAlert([])).quality).toBeUndefined();
    mocks.states.mockResolvedValue(new Map([[COIN, { lastStatus: "degraded", lastAttemptedAt: NOW }]]));
    const evidence = { structuralOnlyIds: new Set([COIN]), scoreIneligibleIds: new Set([COIN]), unknownIds: new Set<string>() };
    mocks.scoringEvidence.mockResolvedValue(evidence);
    const rows = historyRows("degraded");
    const result = await runReservePostSyncWatchdog(historyDb(rows));
    expect(result.status).toBe("ok");
    const metadata = JSON.parse(result.metadata!);
    expect(metadata.activeAdapterAlertReasons).toEqual([`reserve-score-ineligible-sustained:${COIN}`]);
    expect(metadata.reserveAdapterAlert.scoreIneligibleSources).toEqual([{ stablecoinId: COIN, degradedCycles: 3 }]);
    expect(metadata.quality.reasons).toEqual([`reserve-score-ineligible-sustained:${COIN}`, "reserve-sync-degraded"]);
    for (const status of ["error", "degraded"]) {
      mocks.scoringEvidence.mockResolvedValue(status === "degraded" ? { ...evidence, structuralOnlyIds: new Set() } : evidence);
      expect((await runReservePostSyncWatchdog(historyDb(rows.map((row) => historyRow(row.attempted_at, status))))).status).toBe("degraded");
    }
    mocks.scoringEvidence.mockResolvedValue({ ...evidence, unknownIds: new Set([COIN]) });
    expect((await runReservePostSyncWatchdog(historyDb(rows))).status).toBe("degraded");
    mocks.scoringEvidence.mockResolvedValue(evidence);
    const stalled = rows.map((row) => ({ ...row, source_timestamp: 1, freshness_mode: "verified" }));
    expect((await runReservePostSyncWatchdog(historyDb(stalled))).status).toBe("degraded");
    mocks.acknowledged.mockResolvedValue(new Set([COIN]));
    const acknowledged = await readAlert(stalled);
    expect(acknowledged.activeAdapterAlertReasons).toEqual([]);
    expect(acknowledged.reserveAdapterAlert?.recovered).toEqual([]);
    mocks.acknowledged.mockResolvedValue(new Set());
  });


  it("does not charge a degraded attempt that wrote no snapshot as a degraded success", async () => {
    mocks.states.mockResolvedValue(new Map([[COIN, { lastStatus: "degraded" }]]));
    mocks.scoringEvidence.mockResolvedValue(scoringEvidence([COIN]));
    const withheld = (attemptedAt: number) => ({
      ...historyRow(attemptedAt, "degraded"),
      failure_category: "upstream-http",
    });
    const result = await readAlert(cycleTimes.map(withheld));
    expect(result.reserveAdapterAlert?.raised).toEqual([]);
    expect(result.reserveAdapterAlert?.scoreIneligibleSources).toEqual([]);
  });

  it("holds a raised score-ineligible alert when the published snapshot becomes unreadable", async () => {
    mocks.states.mockResolvedValue(new Map([[COIN, { lastStatus: "degraded" }]]));
    mocks.scoringEvidence.mockResolvedValue(scoringEvidence([COIN]));
    const raised = await readAlert(historyRows("degraded"));
    expect(raised.reserveAdapterAlert?.raised).toEqual(["reserve-score-ineligible-sustained"]);

    mocks.scoringEvidence.mockResolvedValue(scoringEvidence([], [COIN]));
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
    mocks.drift.mockResolvedValue(composition([["T-bills", 60], ["Custody cash", 40]]));
    const first = await readAlert([]);
    expect(first.firedRuleIds).not.toContain("reserve-composition-census-drift");
    expect(first.compositionCensus).toEqual({ observedCoins: 1, findings: [] });

    mocks.drift.mockResolvedValue(composition([["T-bills", 30], ["Custody cash", 40], ["Repo", 30]]));
    const second = await readAlert([]);
    expect(second.compositionCensus?.findings).toEqual([expect.objectContaining({
      stablecoinId: COIN, added: ["Repo"], removed: [], shareDriftPct: 30,
    })]);
    expect(second.firedRuleIds).toContain("reserve-composition-census-drift");
    expect(second.quality?.reasons).toContain("reserve-composition-census-drift");
  });

  it("reports an unreadable retained census instead of silently reseeding a clean baseline", async () => {
    mocks.states.mockResolvedValue(new Map());
    mocks.drift.mockResolvedValue(composition([["T-bills", 60], ["Custody cash", 40]]));
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
