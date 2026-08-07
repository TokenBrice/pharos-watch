import { beforeEach, describe, expect, it, vi } from "vitest";
import { SAFETY_SCORE_METHODOLOGY_VERSION as METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import type { PegSummaryCoin } from "@shared/types/market";

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
const mockCapturePegProvenance = vi.fn();
const mockBuildV9PegProvenanceSeed = vi.fn();

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
}));

vi.mock("../../lib/safety-score-v9-peg-provenance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/safety-score-v9-peg-provenance")>()),
  captureSafetyScoreV9PegProvenanceById: mockCapturePegProvenance,
  buildSafetyScoreV9PegProvenanceSeedCacheEntry: mockBuildV9PegProvenanceSeed,
}));

const { prepareSafetyScoreV9Input } = await import("../prepare-safety-score-v9-input");
const { buildNativeSafetyScoreV9Capture } = await import("../../lib/safety-score-v9-capture");
const { NativeSafetyScoreV9InputSchema } = await import("../../lib/safety-score-v9-native-input");

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
    stablecoinsCached: {
      kind: "ok" as const,
      updatedAt: STABLECOINS_UPDATED_AT,
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
            supplyObservedAt: STABLECOINS_UPDATED_AT,
          },
        ],
        fxFallbackRates: {},
      },
    },
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

describe("prepareSafetyScoreV9Input", () => {
  beforeEach(() => {
    for (const mock of [
      mockLoadInputs,
      mockDerivePegAnalytics,
      mockPublishPegAnalytics,
      mockLoadExactDexGeneration,
      mockSetCacheMany,
      mockCapturePegProvenance,
      mockBuildV9PegProvenanceSeed,
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
    mockCapturePegProvenance.mockReturnValue({ [ASSET_ID]: { marker: "compact-peg-provenance" } });
    mockBuildV9PegProvenanceSeed.mockImplementation(({ safetyScoreIdentity }) => ({
      key: "report-cards:v9-peg-provenance-seed:exact",
      value: JSON.stringify({ seed: "v9-peg-provenance", safetyScoreIdentity }),
      storedBytes: 320,
    }));
  });

  it("writes an envelope-v2 capture and its seed under one v9-input identity", async () => {
    const result = await prepareSafetyScoreV9Input({} as D1Database);

    expect(mockSetCacheMany).toHaveBeenCalledTimes(1);
    const [, entries] = mockSetCacheMany.mock.calls[0]!;
    expect(entries.map((entry: { key: string }) => entry.key)).toEqual([
      "report-cards:fixed-input:exact",
      "report-cards:v9-peg-provenance-seed:exact",
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

    const metadata = JSON.parse(String(result.metadata));
    expect(metadata.activeAssets).toBe(1);
    expect(metadata.pegAnalyticsPublished).toBe(true);
    expect(metadata.dexGenerationId).toBe(DEX_GENERATION_ID);
    expect(result.itemCount).toBe(1);
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
    await prepareSafetyScoreV9Input({} as D1Database);

    expect(mockPublishPegAnalytics).toHaveBeenCalledTimes(1);
    expect(mockPublishPegAnalytics.mock.calls[0]![1]).toMatchObject({ nowSec: CLOCK_SEC });
  });

  it("refuses a capture whose DEX generation is not the one the scheduler observed", async () => {
    await expect(
      prepareSafetyScoreV9Input({} as D1Database, undefined, "dex-liquidity-1"),
    ).rejects.toThrow(/captured DEX generation .* expected dex-liquidity-1/);
    expect(mockSetCacheMany).not.toHaveBeenCalled();
  });

  it("refuses a capture that does not cover every active asset", async () => {
    const registry = await import("@shared/lib/stablecoins/registry");
    const activeIds = registry.ACTIVE_IDS as Set<string>;
    activeIds.add("missing-asset");
    try {
      await expect(prepareSafetyScoreV9Input({} as D1Database)).rejects.toThrow(
        /missing 1 active assets: missing-asset/,
      );
    } finally {
      activeIds.delete("missing-asset");
    }
    expect(mockSetCacheMany).not.toHaveBeenCalled();
  });
});
