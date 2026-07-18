import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTelegramDispatchEvents } from "../dispatch-telegram-events";

const mocks = vi.hoisted(() => ({
  buildAlertContextLines: vi.fn(),
  getCache: vi.fn(),
}));

vi.mock("../telegram-alert-context", () => ({
  buildAlertContextLines: mocks.buildAlertContextLines,
}));

vi.mock("../../lib/db-cache", () => ({
  getCache: mocks.getCache,
}));

describe("buildTelegramDispatchEvents", () => {
  beforeEach(() => {
    mocks.buildAlertContextLines.mockResolvedValue(new Map([
      ["coin-dews", "Context: Safety C+ 61"],
      ["coin-depeg", "Context: Safety F 39"],
      ["coin-safe", "Context: Safety C+ 61"],
    ]));
    mocks.getCache.mockResolvedValue(null);
  });

  it("uses Reason lines for safety alerts while keeping Context lines on other alert families", async () => {
    const events = await buildTelegramDispatchEvents(
      {} as D1Database,
      {
        dewsRows: [{
          stablecoin_id: "coin-dews",
          score: 42,
          band: "WARNING",
          signals_json: null,
        }],
        activeDepegRows: [{
          stablecoin_id: "coin-depeg",
          symbol: "DPG",
          direction: "below",
          peak_deviation_bps: 260,
          start_price: 0.974,
          peg_reference: 1,
          event_id: 1,
        }],
      } as never,
      {
        currentSafetySnapshot: {
          "coin-safe": {
            grade: "C+",
            score: 61,
            methodologyVersion: "7.09",
            explain: {
              schemaVersion: 1,
              stages: {
                baseScore: 61,
                postPegScore: 61,
                postNoLiquidityPenaltyScore: 61,
                activeDepegCapScore: null,
                postActiveDepegCapScore: 61,
                scoreBeforeVariantCap: 61,
                finalScore: 61,
                noLiquidityPenaltyApplied: false,
                activeDepegCapApplied: false,
                variantCapApplied: false,
              },
              dimensions: {
                pegStability: { grade: "A", score: 96 },
                liquidity: { grade: "C+", score: 61, detail: "DEX liquidity 61/100" },
                resilience: { grade: "B", score: 72 },
                decentralization: { grade: "B", score: 72 },
                dependencyRisk: { grade: "B", score: 72 },
              },
              rawInputs: {
                pegScore: 96,
                activeDepeg: false,
                activeDepegBps: null,
                liquidityScore: 61,
                effectiveExitScore: 61,
                redemptionBackstopScore: null,
                redemptionUsedForLiquidity: false,
                redemptionRouteFamily: null,
                redemptionModelConfidence: null,
                redemptionExclusionReason: null,
                redemptionImmediateCapacityUsd: null,
                redemptionImmediateCapacityRatio: null,
                concentrationHhi: null,
                canBeBlacklisted: false,
                collateralFromLive: false,
                dependencyFromLive: false,
                dependencyCount: 0,
                variantParentId: null,
                navToken: false,
              },
            },
          },
        },
        previousSafetySnapshot: null,
        safeSafetySnapshot: {
          "coin-safe": {
            grade: "B",
            score: 72,
            methodologyVersion: "7.09",
            explain: {
              schemaVersion: 1,
              stages: {
                baseScore: 72,
                postPegScore: 72,
                postNoLiquidityPenaltyScore: 72,
                activeDepegCapScore: null,
                postActiveDepegCapScore: 72,
                scoreBeforeVariantCap: 72,
                finalScore: 72,
                noLiquidityPenaltyApplied: false,
                activeDepegCapApplied: false,
                variantCapApplied: false,
              },
              dimensions: {
                pegStability: { grade: "A", score: 96 },
                liquidity: { grade: "B", score: 72, detail: "DEX liquidity 72/100" },
                resilience: { grade: "B", score: 72 },
                decentralization: { grade: "B", score: 72 },
                dependencyRisk: { grade: "B", score: 72 },
              },
              rawInputs: {
                pegScore: 96,
                activeDepeg: false,
                activeDepegBps: null,
                liquidityScore: 72,
                effectiveExitScore: 72,
                redemptionBackstopScore: null,
                redemptionUsedForLiquidity: false,
                redemptionRouteFamily: null,
                redemptionModelConfidence: null,
                redemptionExclusionReason: null,
                redemptionImmediateCapacityUsd: null,
                redemptionImmediateCapacityRatio: null,
                concentrationHhi: null,
                canBeBlacklisted: false,
                collateralFromLive: false,
                dependencyFromLive: false,
                dependencyCount: 0,
                variantParentId: null,
                navToken: false,
              },
            },
          },
        },
        safeDewsAlertable: { "coin-dews": "WATCH" },
        safeDewsSnapshot: { "coin-dews": "WATCH" },
        safeDepegSnapshot: {},
        safetySnapshotNeedsSeed: false,
        dewsSnapshotNeedsSeed: false,
        depegSnapshotNeedsSeed: false,
        launchSnapshotNeedsSeed: false,
      } as never,
      (id) => ({ "coin-safe": "SAFE", "coin-dews": "DEWS", "coin-depeg": "DPG" })[id] ?? id,
    );

    expect(events.dewsChanges[0].contextLine).toBe("Context: Safety C+ 61");
    expect(events.depegTriggered[0].contextLine).toBe("Context: Safety F 39");
    expect(events.safetyChanges[0].contextLine).toContain("Reason: Liquidity / Exit fell B -> C+");
    expect(events.safetyChanges[0].contextLine).not.toContain("Context:");
  });

  it("suppresses resolved lines when a depeg closes and reopens in the same window", async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({
            results: [{
              stablecoin_id: "coin-depeg",
              symbol: "DPG",
              peak_deviation_bps: 310,
              started_at: 1_000,
              ended_at: 1_600,
              recovery_price: 1,
            }],
          })),
        })),
      })),
    } as unknown as D1Database;

    const events = await buildTelegramDispatchEvents(
      db,
      {
        dewsRows: [],
        activeDepegRows: [{
          stablecoin_id: "coin-depeg",
          symbol: "DPG",
          direction: "below",
          peak_deviation_bps: 280,
          start_price: 0.972,
          peg_reference: 1,
          event_id: 2,
        }],
      } as never,
      {
        currentSafetySnapshot: {},
        previousSafetySnapshot: null,
        safeSafetySnapshot: {},
        safeDewsAlertable: {},
        safeDewsSnapshot: {},
        safeDepegSnapshot: {
          "coin-depeg": {
            symbol: "DPG",
            direction: "below",
            deviationBps: 310,
            price: 0.969,
            pegReference: 1,
            eventId: 1,
          },
        },
        safetySnapshotNeedsSeed: false,
        dewsSnapshotNeedsSeed: false,
        depegSnapshotNeedsSeed: false,
        launchSnapshotNeedsSeed: false,
      } as never,
      () => "DPG",
    );

    expect(events.depegResolved).toEqual([]);
    expect(events.depegTriggered).toHaveLength(1);
    expect(events.depegTriggered[0].reopenedAfterMinutes).toBe(10);
  });

  it("emits depeg worsening only when a supported subscriber step is crossed", async () => {
    const events = await buildTelegramDispatchEvents(
      {} as D1Database,
      {
        dewsRows: [],
        activeDepegRows: [
          {
            stablecoin_id: "coin-no-step",
            symbol: "NO",
            direction: "below",
            peak_deviation_bps: 150,
            start_price: 0.985,
            peg_reference: 1,
            event_id: 1,
          },
          {
            stablecoin_id: "coin-step",
            symbol: "YES",
            direction: "below",
            peak_deviation_bps: 251,
            start_price: 0.9749,
            peg_reference: 1,
            event_id: 2,
          },
        ],
      } as never,
      {
        currentSafetySnapshot: {},
        previousSafetySnapshot: null,
        safeSafetySnapshot: {},
        safeDewsAlertable: {},
        safeDewsSnapshot: {},
        safeDepegSnapshot: {
          "coin-no-step": {
            symbol: "NO",
            direction: "below",
            deviationBps: 101,
            price: 0.9899,
            pegReference: 1,
            eventId: 1,
          },
          "coin-step": {
            symbol: "YES",
            direction: "below",
            deviationBps: 249,
            price: 0.9751,
            pegReference: 1,
            eventId: 2,
          },
        },
        safetySnapshotNeedsSeed: false,
        dewsSnapshotNeedsSeed: false,
        depegSnapshotNeedsSeed: false,
        launchSnapshotNeedsSeed: false,
      } as never,
      (id) => id,
    );

    expect(events.depegWorsening).toEqual([
      expect.objectContaining({
        stablecoinId: "coin-step",
        previousDeviationBps: 249,
        currentDeviationBps: 251,
      }),
    ]);
  });

  it("does not emit resolved lines for coverage-loss closures", async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({
            results: [{
              stablecoin_id: "coin-depeg",
              symbol: "DPG",
              peak_deviation_bps: 310,
              started_at: 1_000,
              ended_at: 1_600,
              recovery_price: null,
              close_reason: "coverage-lost-supply",
            }],
          })),
        })),
      })),
    } as unknown as D1Database;

    const events = await buildTelegramDispatchEvents(
      db,
      { dewsRows: [], activeDepegRows: [] } as never,
      {
        currentSafetySnapshot: {},
        previousSafetySnapshot: null,
        safeSafetySnapshot: {},
        safeDewsAlertable: {},
        safeDewsSnapshot: {},
        safeDepegSnapshot: {
          "coin-depeg": {
            symbol: "DPG",
            direction: "below",
            deviationBps: 310,
            price: 0.969,
            pegReference: 1,
            eventId: 1,
          },
        },
        safetySnapshotNeedsSeed: false,
        dewsSnapshotNeedsSeed: false,
        depegSnapshotNeedsSeed: false,
        launchSnapshotNeedsSeed: false,
      } as never,
      () => "DPG",
    );

    expect(events.depegResolved).toEqual([]);
    expect(events.depegTriggered).toEqual([]);
  });

  it("allows native-quote recoveries without fabricating a recovery price", async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(async () => ({
            results: [{
              stablecoin_id: "coin-depeg",
              symbol: "DPG",
              peak_deviation_bps: 310,
              started_at: 1_000,
              ended_at: 1_600,
              recovery_price: null,
              close_reason: "recovered-native",
            }],
          })),
        })),
      })),
    } as unknown as D1Database;

    const events = await buildTelegramDispatchEvents(
      db,
      { dewsRows: [], activeDepegRows: [] } as never,
      {
        currentSafetySnapshot: {},
        previousSafetySnapshot: null,
        safeSafetySnapshot: {},
        safeDewsAlertable: {},
        safeDewsSnapshot: {},
        safeDepegSnapshot: {
          "coin-depeg": {
            symbol: "DPG",
            direction: "below",
            deviationBps: 310,
            price: 0.969,
            pegReference: 1,
            eventId: 1,
          },
        },
        safetySnapshotNeedsSeed: false,
        dewsSnapshotNeedsSeed: false,
        depegSnapshotNeedsSeed: false,
        launchSnapshotNeedsSeed: false,
      } as never,
      () => "DPG",
    );

    expect(events.depegResolved).toHaveLength(1);
    expect(events.depegResolved[0].recoveryPrice).toBeNull();
  });
});
