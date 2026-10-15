import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVE_IDS, ACTIVE_META_BY_ID, ACTIVE_STABLECOINS, TRACKED_IDS, TRACKED_META_BY_ID, TRACKED_STABLECOINS } from "@shared/lib/stablecoins/registry";
import type * as WorkerRuntimeRegistry from "@shared/lib/stablecoins/worker-runtime-registry";
import { StablecoinListResponseSchema } from "@shared/types/market";
import { buildSafetyScoreV9InputIdentity } from "@shared/lib/safety-score-v9-input-identity";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { createNativeSafetyScoreV9FullRegistryInput, createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import type { ReportCardsSnapshotInputs } from "../report-cards-snapshot-inputs";

const input = createNativeSafetyScoreV9FullRegistryInput();
const legacy = createSafetyScoreV9FullRegistryInput();
const observedAt = input.clockSec - 100;
const payload = StablecoinListResponseSchema.parse({
  peggedAssets: ACTIVE_STABLECOINS.map((coin) => ({
    id: coin.id, name: coin.name, symbol: coin.symbol, pegType: "peggedUSD", pegMechanism: "fiat-backed",
    price: 1, priceSource: "defillama", priceConfidence: "high", priceObservedAt: observedAt,
    circulating: { peggedUSD: 10_000_000 }, chains: ["Ethereum"],
    chainCirculating: { Ethereum: { current: 10_000_000 } },
  })),
});

// Each pass intentionally reloads the module graph with a different metadata
// owner; static imports would freeze one owner and invalidate the comparison.
async function captureWithMetadata(fullReference: boolean) {
  vi.resetModules();
  vi.doMock("@shared/lib/stablecoins/worker-runtime-registry", async () => {
    const original = await vi.importActual<typeof WorkerRuntimeRegistry>("@shared/lib/stablecoins/worker-runtime-registry");
    return fullReference ? {
      ...original,
      WORKER_ACTIVE_STABLECOINS: ACTIVE_STABLECOINS,
      WORKER_ACTIVE_IDS: ACTIVE_IDS,
      WORKER_ACTIVE_META_BY_ID: ACTIVE_META_BY_ID,
      WORKER_TRACKED_STABLECOINS: TRACKED_STABLECOINS,
      WORKER_TRACKED_IDS: TRACKED_IDS,
      WORKER_TRACKED_META_BY_ID: TRACKED_META_BY_ID,
    } : original;
  });
  const [snapshotInputs, snapshot, pegAnalytics, pegCache, journalStore, acceptedProjectionReaders, capture, nativeInput] = await Promise.all([
    import("../report-cards-snapshot-inputs"), import("../report-cards-snapshot"), import("../peg-analytics"),
    import("../peg-analytics-cache"), import("../report-card-evidence-journal-store"),
    import("../safety-score-v9/accepted-projection-readers"), import("../safety-score-v9/capture"), import("../safety-score-v9/native-input"),
  ]);
  const inputs: ReportCardsSnapshotInputs = {
    stablecoinsCached: { kind: "ok", updatedAt: input.updatedAt, payload },
    dexLiquiditySnapshot: {
      latestUpdatedAt: observedAt,
      map: Object.fromEntries(Object.entries(legacy.dexLiqMap).map(([id, row]) => [id, {
        liquidityScore: row.liquidityScore, concentrationHhi: row.concentrationHhi,
        poolCount: row.poolCount, chainCount: row.chainCount,
        exitRouteObservations: row.exitRouteObservations,
        exitRouteObservationCoverage: row.exitRouteObservationCoverage,
        methodologyVersion: legacy.inputMethodologyVersions.dexLiquidity[0],
      }])),
    },
    redemptionBackstopMap: {},
    redemptionSnapshotProvenance: { runId: null, latestUpdatedAt: null, methodologyVersion: null },
    liveReserveMap: new Map(Object.entries(input.liveReserveMap)),
    liveReserveProvenanceMap: new Map(Object.entries(input.liveReserveProvenanceMap)),
    liquidityStale: false, redemptionStale: true, inputFreshness: input.inputFreshness,
    v9PublicationInputHealth: {
      dex: { state: "current", generationId: input.dexGenerationId, updatedAtSec: observedAt },
      redemption: { state: "unavailable", generationId: null, updatedAtSec: null },
      liveReserves: { state: "available", coverageRatio: 1 },
    },
  };
  vi.spyOn(snapshotInputs, "loadReportCardsSnapshotInputs").mockResolvedValue(inputs);
  vi.spyOn(snapshot, "loadExactDexPublicationGeneration").mockResolvedValue({ generationId: input.dexGenerationId, updatedAt: observedAt });
  vi.spyOn(pegAnalytics, "derivePegAnalyticsSnapshot").mockResolvedValue({
    nowSec: input.clockSec, allEvents: [], eventsByCoin: new Map(), pegDataById: new Map(Object.entries(input.pegDataById)),
  });
  vi.spyOn(pegCache, "publishPegAnalyticsCache").mockResolvedValue(true);
  vi.spyOn(journalStore, "loadReportCardEvidenceJournalByIdV1").mockResolvedValue({});
  vi.spyOn(acceptedProjectionReaders, "loadSafetyScoreV9LenderCollateralState").mockResolvedValue({ kind: "bootstrap", health: null });
  const captured = await capture.buildNativeSafetyScoreV9Capture(mockD1(), { expectedDexGenerationId: input.dexGenerationId });
  const identity = buildSafetyScoreV9InputIdentity({
    methodologyVersion: captured.input.methodologyVersion,
    baseInputGenerationId: captured.input.baseInputGenerationId,
    publicationGenerationId: captured.input.sourceGeneration,
  });
  const stored = await nativeInput.buildNativeV9InputCacheEntry(captured.input, identity);
  vi.restoreAllMocks();
  return { captured, stored };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@shared/lib/stablecoins/worker-runtime-registry");
  vi.resetModules();
});

describe("full-fixture native V9 prep metadata ownership", () => {
  it("preserves exact native input bytes, stored envelope and base generation against full metadata", async () => {
    const reference = await captureWithMetadata(true);
    const projected = await captureWithMetadata(false);
    expect(projected.captured.completeness.expectedCount).toBe(ACTIVE_STABLECOINS.length);
    expect(projected.captured.input.activeAssetIds).toEqual(ACTIVE_STABLECOINS.map((coin) => coin.id).sort());
    expect(projected.captured.input.baseInputGenerationId).toBe(reference.captured.input.baseInputGenerationId);
    expect(stableJsonStringifyV1(projected.captured.input)).toBe(stableJsonStringifyV1(reference.captured.input));
    expect(JSON.stringify(projected.captured.input)).toBe(JSON.stringify(reference.captured.input));
    expect(projected.stored).toEqual(reference.stored);
  }, 120_000);
});
