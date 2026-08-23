import type { RedemptionBackstopConfig } from "@shared/lib/redemption-backstops";
import type { ReserveSnapshotMetadataRecord } from "../live-reserves-store";

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

export function snapshot(
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
