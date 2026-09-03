import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION as METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/safety-score";
import type { PegSummaryCoin } from "@shared/types/market";
import { makeNoopD1 } from "../../test-helpers/noop-d1";

const ASSET_ID = "usdc-circle";
const CLOCK_SEC = 1_783_891_200;
const DEX_UPDATED_AT = 1_783_891_100;
const STABLECOINS_UPDATED_AT = 1_783_891_000;
const DEX_GENERATION_ID = `dex-liquidity-${DEX_UPDATED_AT}`;

const mockLoadInputs = vi.fn();
const mockDerivePegAnalytics = vi.fn();
const mockPublishPegAnalytics = vi.fn();
const mockLoadExactDexGeneration = vi.fn();
const mockSetCacheMany = vi.fn();
const mockGetCacheUpdatedAt = vi.fn();
const mockLoadStablecoinsCache = vi.fn();
const mockCapturePegProvenance = vi.fn();
const mockBuildV9PegProvenanceSeed = vi.fn();
const mockObserveTransferMateriality = vi.fn();

vi.mock("@shared/lib/stablecoins/registry", async (importOriginal) => {
  const original = await importOriginal<typeof import("@shared/lib/stablecoins/registry")>();
  const meta = original.ACTIVE_STABLECOINS.find((coin) => coin.id === ASSET_ID)!;
  return {
    ...original,
    ACTIVE_STABLECOINS: [meta],
    ACTIVE_IDS: new Set([ASSET_ID]),
    ACTIVE_META_BY_ID: new Map([[ASSET_ID, meta]]),
  };
});

vi.mock("../../lib/report-cards-snapshot-inputs", () => ({
  loadReportCardsSnapshotInputs: mockLoadInputs,
}));

vi.mock("../../lib/peg-analytics", () => ({
  derivePegAnalyticsSnapshot: mockDerivePegAnalytics,
}));

vi.mock("../../lib/peg-analytics-cache", () => ({
  publishPegAnalyticsCache: mockPublishPegAnalytics,
}));

vi.mock("../../lib/report-cards-snapshot", () => ({
  loadExactDexPublicationGeneration: mockLoadExactDexGeneration,
  buildNavPriceById: () => ({}),
  resolveExactRedemptionPublicationGeneration: () => "redemption-backstops-unavailable",
}));

vi.mock("../../lib/db-cache", () => ({
  setCacheMany: mockSetCacheMany,
  getCacheUpdatedAt: mockGetCacheUpdatedAt,
}));

vi.mock("../../lib/stablecoins-cache", () => ({
  loadStablecoinsCache: mockLoadStablecoinsCache,
}));

vi.mock("../../lib/safety-score-v9-peg-provenance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/safety-score-v9-peg-provenance")>()),
  captureSafetyScoreV9PegProvenanceById: mockCapturePegProvenance,
  buildSafetyScoreV9PegProvenanceSeedCacheEntry: mockBuildV9PegProvenanceSeed,
}));

vi.mock("../../lib/safety-score-v9-transfer-materiality-observer", () => ({
  observeSafetyScoreV9TransferMaterialityGeneration: mockObserveTransferMateriality,
}));

const {
  prepareSafetyScoreV9Input,
  V9_INPUT_STABLECOINS_SETTLE_MAX_WAIT_MS,
} = await import("../prepare-safety-score-v9-input");
const { buildNativeSafetyScoreV9Capture } = await import("../../lib/safety-score-v9-capture");
const { NativeSafetyScoreV9InputSchema } = await import("../../lib/safety-score-v9-native-input");

type ProgressRow = {
  started_at: number;
  updated_at: number;
  stage: string | null;
  lease_owner: string | null;
  lease_until: number;
} | null;

function makeDb(progressRows: ProgressRow[] = [null]): D1Database {
  let progressIndex = 0;
  return makeNoopD1({
    prepare: () => ({
      bind: () => ({
        first: async () => {
          const row = progressRows[Math.min(progressIndex, progressRows.length - 1)] ?? null;
          progressIndex += 1;
          return row;
        },
      }),
    }),
  });
}

function pegSummary(): PegSummaryCoin {
  return {
    id: ASSET_ID,
    symbol: "USDC",
    name: "USD Coin",
    pegType: "peggedUSD",
    pegCurrency: "USD",
    governance: "centralized",
    currentDeviationBps: 1,
    pegScore: 99,
    pegPct: 99.9,
    severityScore: 0,
    spreadPenalty: 0,
    eventCount: 0,
    worstDeviationBps: 12,
    activeDepeg: false,
    lastEventAt: null,
    trackingSpanDays: 1_000,
    methodologyVersion: "6.0",
  };
}

function snapshotInputs() {
  return {
    stablecoinsCached: stablecoinsCache(),
    bluechipCached: null,
    dexLiquiditySnapshot: {
      map: {
        [ASSET_ID]: {
          liquidityScore: 80,
          concentrationHhi: 0.2,
          poolCount: 4,
          chainCount: 2,
          methodologyVersion: "1.0",
          updatedAt: DEX_UPDATED_AT,
        },
      },
      latestUpdatedAt: DEX_UPDATED_AT,
    },
    redemptionBackstopMap: {},
    redemptionSnapshotProvenance: { runId: null, methodologyVersion: null, latestUpdatedAt: null },
    liveReserveMap: new Map(),
    liveReserveProvenanceMap: new Map(),
    liquidityStale: false,
    redemptionStale: true,
    inputFreshness: {
      dexLiquidity: { updatedAt: DEX_UPDATED_AT, ageSeconds: 0, stale: false },
      redemptionBackstops: { updatedAt: null, ageSeconds: null, stale: true },
    },
    v9PublicationInputHealth: {
      dex: { state: "current" as const, generationId: DEX_GENERATION_ID, updatedAtSec: DEX_UPDATED_AT },
      redemption: { state: "not-applicable" as const, generationId: null, updatedAtSec: null },
      liveReserves: { state: "available" as const },
    },
  };
}

function stablecoinsCache(updatedAt = STABLECOINS_UPDATED_AT) {
  return {
    kind: "ok" as const,
    updatedAt,
    payload: {
      peggedAssets: [
        {
          id: ASSET_ID,
          circulating: { peggedUSD: 1_000 },
          chainCirculating: {
            ethereum: {
              current: 1_000,
              circulatingPrevDay: 900,
              circulatingPrevWeek: 800,
              circulatingPrevMonth: 700,
            },
          },
          supplyObservedAt: updatedAt,
        },
      ],
      fxFallbackRates: {},
    },
  };
}

describe("prepareSafetyScoreV9Input", () => {
  beforeEach(() => {
    vi.useRealTimers();
    for (const mock of [
      mockLoadInputs,
      mockDerivePegAnalytics,
      mockPublishPegAnalytics,
      mockLoadExactDexGeneration,
      mockSetCacheMany,
      mockGetCacheUpdatedAt,
      mockLoadStablecoinsCache,
      mockCapturePegProvenance,
      mockBuildV9PegProvenanceSeed,
      mockObserveTransferMateriality,
    ]) {
      mock.mockReset();
    }
    mockLoadInputs.mockResolvedValue(snapshotInputs());
    mockDerivePegAnalytics.mockResolvedValue({
      nowSec: CLOCK_SEC,
      allEvents: [],
      eventsByCoin: new Map(),
      pegDataById: new Map([[ASSET_ID, pegSummary()]]),
    });
    mockPublishPegAnalytics.mockResolvedValue(true);
    mockLoadExactDexGeneration.mockResolvedValue({
      generationId: DEX_GENERATION_ID,
      updatedAt: DEX_UPDATED_AT,
    });
    mockSetCacheMany.mockResolvedValue(undefined);
    mockGetCacheUpdatedAt.mockResolvedValue(STABLECOINS_UPDATED_AT);
    mockLoadStablecoinsCache.mockResolvedValue(stablecoinsCache());
    mockCapturePegProvenance.mockReturnValue({ [ASSET_ID]: { marker: "compact-peg-provenance" } });
    mockBuildV9PegProvenanceSeed.mockImplementation(({ safetyScoreIdentity }) => ({
      key: "report-cards:v9-peg-provenance-seed:exact",
      value: JSON.stringify({ seed: "v9-peg-provenance", safetyScoreIdentity }),
      storedBytes: 320,
    }));
    mockObserveTransferMateriality.mockImplementation((input) =>
      ({
        schemaVersion: 1,
        kind: "safety-score-v9-transfer-materiality-generation",
        sourceBaseInputGenerationId: input.baseInputGenerationId,
        registryFingerprint: input.registryFingerprint,
        capturedAtSec: input.scoringClockSec,
        observationsByAssetId: {},
        generationId: `safety-score-v9-transfer-materiality:v1:${"a".repeat(64)}`,
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes an envelope-v2 capture and its seed under one v9-input identity", async () => {
    const result = await prepareSafetyScoreV9Input(makeDb());

    expect(mockSetCacheMany).toHaveBeenCalledTimes(1);
    const [, entries] = mockSetCacheMany.mock.calls[0]!;
    expect(entries.map((entry: { key: string }) => entry.key)).toEqual([
      "report-cards:fixed-input:exact",
      "safety-score-v9:supply-attribution-source:v1",
      "report-cards:v9-peg-provenance-seed:exact",
      "safety-score-v9:transfer-materiality-generation:v1",
    ]);

    const envelope = JSON.parse(entries[0].value) as Record<string, unknown>;
    expect(envelope.schemaVersion).toBe(2);
    expect(envelope.safetyScoreIdentity).toMatchObject({
      model: "v9-input",
      schemaVersion: 1,
      methodologyVersion: METHODOLOGY_VERSION,
      publicationGenerationId: `report-cards:${METHODOLOGY_VERSION}:${STABLECOINS_UPDATED_AT}`,
    });
    expect((envelope.safetyScoreIdentity as { baseInputGenerationId: string }).baseInputGenerationId).toMatch(
      /^report-cards-input:v1:[a-f0-9]{64}$/,
    );

    // The seed carries the same identity object, so both rows are one capture.
    expect(mockBuildV9PegProvenanceSeed).toHaveBeenCalledTimes(1);
    expect(mockBuildV9PegProvenanceSeed.mock.calls[0]![0].safetyScoreIdentity).toEqual(
      envelope.safetyScoreIdentity,
    );
    const observedTransferInput = mockObserveTransferMateriality.mock.calls[0]![0];
    expect(JSON.parse(entries[1].value)).toMatchObject({
      schemaVersion: 1,
      kind: "safety-score-v9-supply-attribution-source",
      activeAssetIds: [],
    });
    const transferMateriality = JSON.parse(entries[3].value) as Record<string, unknown>;
    expect(transferMateriality).toMatchObject({
      sourceBaseInputGenerationId:
        (envelope.safetyScoreIdentity as { baseInputGenerationId: string }).baseInputGenerationId,
      registryFingerprint: observedTransferInput.registryFingerprint,
      capturedAtSec: observedTransferInput.scoringClockSec,
    });
    expect(mockObserveTransferMateriality).toHaveBeenCalledWith(expect.objectContaining({
      baseInputGenerationId:
        (envelope.safetyScoreIdentity as { baseInputGenerationId: string }).baseInputGenerationId,
      registryFingerprint: observedTransferInput.registryFingerprint,
      scoringClockSec: observedTransferInput.scoringClockSec,
    }));

    const metadata = JSON.parse(String(result.metadata));
    expect(metadata.activeAssets).toBe(1);
    expect(metadata.pegAnalyticsPublished).toBe(true);
    expect(metadata.dexGenerationId).toBe(DEX_GENERATION_ID);
    expect(metadata.transferMateriality).toMatchObject({
      status: "published",
      generationId: transferMateriality.generationId,
      observedAssetCount: 0,
      acceptedAssetCount: 0,
      rejectedAssetCount: 0,
    });
    expect(metadata.stablecoinsCacheReadiness).toMatchObject({
      pendingStartedAt: null,
    });
    expect(result.itemCount).toBe(1);
  });

  it("publishes the exact input without replacing transfer materiality after an unexpected observer failure", async () => {
    mockObserveTransferMateriality.mockRejectedValueOnce(new TypeError("observer invariant failed"));

    const result = await prepareSafetyScoreV9Input(makeDb());

    expect(mockSetCacheMany).toHaveBeenCalledTimes(1);
    const [, entries] = mockSetCacheMany.mock.calls[0]!;
    expect(entries.map((entry: { key: string }) => entry.key)).toEqual([
      "report-cards:fixed-input:exact",
      "safety-score-v9:supply-attribution-source:v1",
      "report-cards:v9-peg-provenance-seed:exact",
    ]);
    expect(result).toMatchObject({
      status: "degraded",
      itemCount: 1,
    });
    expect(result.productivity).toEqual({
      productive: true,
      reason: "safety-score-v9-input-published-with-transfer-materiality-unavailable",
    });
    expect(JSON.parse(String(result.metadata)).transferMateriality).toEqual({
      status: "unavailable",
      code: "TypeError",
    });
  });

  it("propagates genuine observer cancellation without publishing a partial input batch", async () => {
    const controller = new AbortController();
    mockObserveTransferMateriality.mockImplementationOnce(async () => {
      controller.abort(new Error("observer cancelled"));
      throw new Error("observer stopped");
    });

    await expect(
      prepareSafetyScoreV9Input(makeDb(), controller.signal),
    ).rejects.toThrow("observer cancelled");
    expect(mockSetCacheMany).not.toHaveBeenCalled();
  });

  it("captures a payload that parses under the native v4 schema and carries peg rows", async () => {
    const capture = await buildNativeSafetyScoreV9Capture({} as D1Database);

    expect(NativeSafetyScoreV9InputSchema.safeParse(capture.input).success).toBe(true);
    expect(capture.input.schemaVersion).toBe(4);
    expect(capture.input.captureKind).toBe("native-v9-inputs");
    expect(Object.keys(capture.input.pegDataById)).toEqual([ASSET_ID]);
    expect(capture.input.chainCirculatingById[ASSET_ID]).toEqual({ ethereum: { current: 1_000 } });
    expect(capture.input.dexLiqMap[ASSET_ID]).toEqual({ updatedAt: DEX_UPDATED_AT });
    expect(capture.input.inputMethodologyVersions.dexLiquidity).toEqual(["1.0"]);
    expect(capture.pegAnalyticsPublished).toBe(true);
  });

  it("publishes the peg-analytics aggregate exactly once per capture", async () => {
    await prepareSafetyScoreV9Input(makeDb());

    expect(mockPublishPegAnalytics).toHaveBeenCalledTimes(1);
    expect(mockPublishPegAnalytics.mock.calls[0]![1]).toMatchObject({ nowSec: CLOCK_SEC });
  });

  it("refuses a capture whose DEX generation is not the one the scheduler observed", async () => {
    await expect(
      prepareSafetyScoreV9Input(makeDb(), undefined, "dex-liquidity-1"),
    ).rejects.toThrow(/captured DEX generation .* expected dex-liquidity-1/);
    expect(mockSetCacheMany).not.toHaveBeenCalled();
  });

  it("passes the settled stablecoins cache into the native capture", async () => {
    const settledCache = stablecoinsCache();

    mockLoadStablecoinsCache.mockResolvedValueOnce(settledCache);
    await prepareSafetyScoreV9Input(makeDb());

    expect(mockLoadInputs).toHaveBeenCalledWith(expect.anything(), {
      preloadedStablecoinsCache: settledCache,
    });
  });

  it("waits for an active stablecoins run before capturing V9 input", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const settledCache = stablecoinsCache(200);
    const activeProgress = {
      started_at: 200,
      updated_at: 201,
      stage: "pricing",
      lease_owner: "lease-a",
      lease_until: 999,
    };
    mockGetCacheUpdatedAt
      .mockResolvedValueOnce(100)
      .mockResolvedValueOnce(200);
    mockLoadStablecoinsCache.mockResolvedValueOnce(settledCache);

    const promise = prepareSafetyScoreV9Input(makeDb([activeProgress, activeProgress]));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_500);
    const result = await promise;

    expect(result.status).toBeUndefined();
    expect(mockLoadInputs).toHaveBeenCalledWith(expect.anything(), {
      preloadedStablecoinsCache: settledCache,
    });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      stablecoinsCacheReadiness: {
        waitedMs: 2500,
        pendingStartedAt: 200,
      },
    });
  });

  it("does not overwrite the fixed input while a newer stablecoins generation remains pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const activeProgress = {
      started_at: 200,
      updated_at: 201,
      stage: "pricing",
      lease_owner: "lease-a",
      lease_until: 999,
    };
    mockGetCacheUpdatedAt.mockResolvedValue(100);

    const promise = prepareSafetyScoreV9Input(makeDb([activeProgress]));
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(V9_INPUT_STABLECOINS_SETTLE_MAX_WAIT_MS);
    const result = await promise;

    expect(result).toMatchObject({
      status: "degraded",
      itemCount: 0,
      productivity: {
        productive: false,
        reason: "safety-score-v9-input-source-unavailable",
      },
    });
    expect(JSON.parse(result.metadata ?? "{}")).toMatchObject({
      stage: "stablecoins-cache-readiness",
      reason: "stablecoins-generation-pending",
      pendingStablecoinsStartedAt: 200,
      pendingStablecoinsStage: "pricing",
    });
    expect(mockLoadInputs).not.toHaveBeenCalled();
    expect(mockSetCacheMany).not.toHaveBeenCalled();
  });
});
