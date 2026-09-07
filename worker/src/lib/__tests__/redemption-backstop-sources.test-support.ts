import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import type { RedemptionRouteAvailability } from "../redemption-backstop/availability";
import type { RedemptionBackstopBuildOptions } from "../redemption-backstop/capacity";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves/store";

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
