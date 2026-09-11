import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { RedemptionRouteAvailability } from "../redemption-backstop/availability";
import type { RedemptionBackstopBuildOptions } from "../redemption-backstop/capacity";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves/store";
import type { FpiControllerV9RouteState } from "../fpi-controller-redemption-route";

const BASE_REDEMPTION_ROUTE: RedemptionBackstopConfig = {
  routeFamily: "stablecoin-redeem",
  accessModel: "permissionless-onchain",
  settlementModel: "atomic",
  executionModel: "deterministic-onchain",
  outputAssetType: "stable-single",
  capacityModel: { kind: "supply-full" },
  costModel: { kind: "fee-bps", feeBps: 0 },
};

export function route(overrides: Partial<RedemptionBackstopConfig> = {}): RedemptionBackstopConfig {
  return { ...BASE_REDEMPTION_ROUTE, ...overrides };
}

export function liveSnapshot(
  stablecoinId: string,
  metadata: Record<string, unknown> = {},
  overrides: Partial<ReserveSnapshotMetadataRecord> = {},
): ReserveSnapshotMetadataRecord {
  return {
    stablecoinId,
    fetchedAt: 1_699_999_880,
    source: "test",
    metadata,
    warningCount: 0,
    warnings: [],
    sourceModel: "dynamic-mix",
    evidenceClass: "independent",
    syncStatus: "ok",
    ...overrides,
  } as ReserveSnapshotMetadataRecord;
}

export function snapshot(
  stablecoinId: string,
  metadata: Record<string, unknown> = {},
  overrides: Partial<ReserveSnapshotMetadataRecord> = {},
): ReserveSnapshotMetadataRecord {
  return liveSnapshot(stablecoinId, metadata, overrides);
}

export function dusdOpenQueueMetadata(nowSec: number): Record<string, unknown> {
  return {
    freshnessMode: "verified",
    sourceTimestamp: nowSec - 120,
    redemption: {
      capacityUsd: 0,
      settlementBoundUnproven: true,
      capacityKind: "live-queue",
      freshnessKind: "same-run-onchain",
      queueDepthUsd: 3_104.889979,
      holderEligibility: "any-holder",
      routeStatus: "open",
      routeStatusSource: "onchain",
    },
    redemptionQueue: {
      minimumFinalizationDelaySec: 43_200,
    },
  };
}

export function severeMarketEvidence(
  overrides: Partial<RedemptionRouteAvailability> = {},
): RedemptionRouteAvailability {
  return {
    routeStatus: "degraded",
    routeStatusSource: "market-implied",
    routeStatusReason: "Active severe depeg",
    routeStatusReviewedAt: "2026-05-12",
    activeDepegBps: 3000,
    activeDepegStartedAt: 1_777_000_000,
    activeDepegDirection: "below",
    ...overrides,
  };
}

type BuildEntry = (
  db: D1Database,
  stablecoinId: string,
  config: RedemptionBackstopConfig,
  supplyUsd: number | null,
  dexLiquidityScore: number | null,
  nowSec: number,
  options?: RedemptionBackstopBuildOptions,
) => Promise<RedemptionBackstopEntry>;

export function buildEntryFixture(
  build: BuildEntry,
  input: {
    db: D1Database;
    stablecoinId: string;
    route: RedemptionBackstopConfig;
    supplyUsd: number | null;
    dexScore: number | null;
    nowSec: number;
    snapshot?: ReserveSnapshotMetadataRecord | null;
    availability?: RedemptionRouteAvailability | null;
    options?: RedemptionBackstopBuildOptions;
  },
): Promise<RedemptionBackstopEntry> {
  const options: RedemptionBackstopBuildOptions = {
    ...input.options,
    ...(input.snapshot !== undefined ? { reserveSnapshotMetadata: input.snapshot } : {}),
    ...(input.availability !== undefined ? { routeAvailability: input.availability } : {}),
  };
  return build(
    input.db,
    input.stablecoinId,
    input.route,
    input.supplyUsd,
    input.dexScore,
    input.nowSec,
    options,
  );
}

export function fpiControllerState(now: number, blockAgeSec: number): FpiControllerV9RouteState {
  return {
    kind: "fpi-controller-v1",
    chain: "ethereum",
    controllerAddress: "0x2397321b301b80a1c0911d6f9ed4b6033d43cf51",
    controllerCodeHash: "0x8f8968ffbb928926343d4217667f094cc938f359e253ef25ff33ee7b85ec1132",
    blockNumber: 25_600_682,
    blockTimestamp: now - blockAgeSec,
    inputTokenAddress: "0x5ca135cb8527d76e932f34b5145575f9d8cbe08e",
    outputTokenAddress: "0x853d955acef822db058eb8505911ed77f175b99e",
    outputTrackedAssetId: "frax-frax",
    fraxPriceFeedAddress: "0xb9e1e3a9feff48998e45fa90847ed4d467e8bcfd",
    fraxPriceFeedCodeHash: "0xbd6f524cdc4268b6bd1bb6f77a8821faeea9c52ee9e0afa0b6d948ce82c966c2",
    fraxPriceFeedRoundId: "36893488147419121260",
    fraxPriceFeedUpdatedAt: now - 120,
    fraxPriceFeedAgeSec: 120 - blockAgeSec,
    fpiPriceFeedAddress: "0x59985d79e1e69f659f4ab97db07a35ce73d9174b",
    fpiPriceFeedCodeHash: "0x2b165ff401e6d9ee29c0ef100b238ecb2fb7c89715104dde46b95547cea302fb",
    fpiPriceFeedRoundId: "0",
    fpiPriceFeedUpdatedAt: now - blockAgeSec,
    fpiPriceFeedAgeSec: 0,
    maxPriceFeedAgeSec: 7_200,
    cpiTrackerAddress: "0x66b7dff2ac66dc4d6fbb3db1cb627bbb01ff3146",
    cpiTrackerCodeHash: "0xb989d68e59e9df4ef6d1782d56efe24f44bbb1d9e015c523c6e30adde9a7821d",
    cpiTrackerUpdatedAt: now - 90 * 86_400,
    cpiTrackerAgeSec: 90 * 86_400 - blockAgeSec,
    fullConfidenceCpiTrackerAgeSec: 62 * 86_400,
    maxCpiTrackerAgeSec: 366 * 86_400,
    cpiTrackerFreshness: "stale-bounded",
    modelConfidence: "medium",
    feeBps: 30,
    pegPriceUsd: 1.157936,
    fpiPriceUsd: 1.153952,
    pegDifferenceBps: 34.52,
    pegBandBps: 500,
    quoteInputFpi: 1,
    quoteOutputFrax: 1.154462,
    outputPriceUsd: 0.98839875,
    allInCostBps: (1 - (1.154462 * 0.98839875) / 1.157936) * 10_000,
    controllerOutputBalance: 621_116.75,
    maxRedeemableFpi: 537_994.25,
    capacityUsd: 537_994.25 * 1.157936,
    sourceUrls: ["https://docs.frax.finance/frax-price-index/fpi-controller-pool"],
  };
}
