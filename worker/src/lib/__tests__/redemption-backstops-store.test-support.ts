import { mockD1, type MockD1Database, type MockTableConfig } from "../../test-helpers/__shared/mock-d1";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";

export const COMPLETED_RUNS_SQL =
  "SELECT run_id, completed_at, expected_count, written_count, min_updated_at, max_updated_at, methodology_version, status, metadata_json FROM redemption_backstop_runs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT ?";
export const RUN_ROWS_BY_RUN_ID_SQL =
  "SELECT stablecoin_id, score, dex_liquidity_score, access_score, settlement_score, execution_certainty_score, capacity_score, output_asset_quality_score, cost_score, route_family, access_model, settlement_model, execution_model, output_asset_type, provider, source_mode, immediate_capacity_usd, immediate_capacity_ratio, fee_bps, queue_enabled, updated_at, methodology_version, details_json, snapshot_run_id FROM redemption_backstop_run_rows WHERE snapshot_run_id = ?";

const REDEMPTION_WRITE_TABLES: MockTableConfig[] = [
  { match: "INSERT INTO redemption_backstop_runs", rows: [] },
  { match: "INSERT INTO redemption_backstop_run_rows", rows: [] },
  { match: "INSERT OR REPLACE INTO redemption_backstop_history", rows: [] },
  { match: "UPDATE redemption_backstop_runs", rows: [], runMeta: { changes: 1 } },
  { match: "DELETE FROM redemption_backstop_run_rows", rows: [], runMeta: { changes: 0 } },
  { match: "DELETE FROM redemption_backstop_runs", rows: [], runMeta: { changes: 0 } },
  { match: "DELETE FROM redemption_backstop_history", rows: [], runMeta: { changes: 0 } },
];

export function mockRedemptionD1(tables: MockTableConfig[] = []): MockD1Database {
  return mockD1([...tables, ...REDEMPTION_WRITE_TABLES]);
}

export function completedRunsQuery(rows: Record<string, unknown>[]): MockTableConfig {
  return { match: COMPLETED_RUNS_SQL, matchBinds: [5], rows };
}

export function completedRunsTable(rows: Record<string, unknown>[]): MockTableConfig {
  return { match: "FROM redemption_backstop_runs", rows };
}

export function runRowsQuery(runId: string, rows: Record<string, unknown>[]): MockTableConfig {
  return { match: RUN_ROWS_BY_RUN_ID_SQL, matchBinds: [runId], rows };
}

export function runRowsTable(runId: string, rows: Record<string, unknown>[]): MockTableConfig {
  return { match: "WHERE snapshot_run_id = ?", matchBinds: [runId], rows };
}

export function completedRunRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "run-live",
    completed_at: 1_700_000_010,
    expected_count: 1,
    written_count: 1,
    min_updated_at: 1_700_000_000,
    max_updated_at: 1_700_000_000,
    methodology_version: "4.07",
    ...overrides,
  };
}

export function makeRealisticRedemptionRow(overrides: Record<string, unknown> = {}) {
  return {
    stablecoin_id: "eurc-circle",
    score: 65,
    dex_liquidity_score: 44,
    access_score: 40,
    settlement_score: 65,
    execution_certainty_score: 60,
    capacity_score: 100,
    output_asset_quality_score: 100,
    cost_score: 40,
    route_family: "offchain-issuer",
    access_model: "issuer-api",
    settlement_model: "same-day",
    execution_model: "rules-based-nav",
    output_asset_type: "stable-single",
    provider: "supply-full-model",
    source_mode: "estimated",
    immediate_capacity_usd: null,
    immediate_capacity_ratio: null,
    fee_bps: null,
    queue_enabled: 0,
    updated_at: 1_700_000_000,
    methodology_version: "1.1",
    details_json: JSON.stringify({
      resolutionState: "resolved",
      capacityConfidence: "heuristic",
      capacitySemantics: "eventual-only",
      feeConfidence: "undisclosed-reviewed",
      feeModelKind: "undisclosed-reviewed",
      modelConfidence: "low",
      routeStatus: "open",
      routeStatusSource: "static-config",
      holderEligibility: "verified-customer",
      capacityProfile: {
        immediateUsd: 10_000_000,
        dailyLimitUsd: 5_000_000,
        queuedUsd: 12_000_000,
        eventualUsd: null,
        scoringUsd: 5_000_000,
        scoringHorizon: "daily",
        capacityProfileConfidence: "heuristic",
        modeledExitSizeUsd: 1_000_000,
      },
      capacityKind: "live-proxy-validated",
      freshnessKind: "verified-source-timestamp",
      sourceTimestamp: 1_699_999_900,
      sourceUrls: ["https://example.com/redemption.json"],
      settlementDelaySec: 3600,
      queueDepthUsd: 12_000_000,
      dailyLimitUsd: 5_000_000,
      minRedeemUsd: 100_000,
      liveHolderEligibility: "whitelisted-primary",
      eventualRedeemabilityScore: 72,
      confidenceDetails: {
        capacityEvidenceQuality: 40,
        feeEvidenceQuality: 50,
        routeStatusFreshness: 60,
        holderCohortBreadth: 70,
        sourceQuality: 80,
        reviewedDocAgeDays: 30,
        reasons: ["heuristic capacity"],
      },
      costScenarioScores: {
        retail: 30,
        activeUser: 40,
        institutional: null,
      },
      routeExitCorrelation: "independent-issuer-rail",
      capsApplied: ["offchain-route-cap"],
      feeDescription: "EEA burn fee is 0 bps; other Circle redemption fees may vary",
      docs: { label: "Reserve feed", url: "https://example.com/reserves", provenance: "proof-of-reserves" },
      notes: ["Some note"],
    }),
    ...overrides,
  };
}

export function makeRedemptionWriteRecord(
  overrides: Partial<RedemptionBackstopEntry> = {},
): RedemptionBackstopEntry {
  return {
    stablecoinId: "eurc-circle",
    score: 65,
    dexLiquidityScore: 44,
    accessScore: 40,
    settlementScore: 65,
    executionCertaintyScore: 60,
    capacityScore: 100,
    outputAssetQualityScore: 100,
    costScore: 40,
    routeFamily: "offchain-issuer",
    accessModel: "issuer-api",
    settlementModel: "same-day",
    executionModel: "rules-based-nav",
    outputAssetType: "stable-single",
    provider: "supply-full-model",
    sourceMode: "estimated",
    resolutionState: "resolved",
    routeStatus: "open",
    routeStatusSource: "static-config",
    holderEligibility: "verified-customer",
    capacityConfidence: "heuristic",
    capacitySemantics: "eventual-only",
    feeConfidence: "undisclosed-reviewed",
    feeModelKind: "undisclosed-reviewed",
    modelConfidence: "low",
    immediateCapacityUsd: null,
    immediateCapacityRatio: null,
    feeBps: null,
    queueEnabled: false,
    methodologyVersion: "1.1",
    updatedAt: 1_700_000_000,
    capsApplied: ["offchain-route-cap"],
    ...overrides,
  };
}
