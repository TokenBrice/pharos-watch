import { mockD1Strict } from "@shared/test-utils/mock-d1";

export function makeRedemptionRow(overrides: Record<string, unknown> = {}) {
  return {
    stablecoin_id: "cusd-cap",
    score: 88,
    dex_liquidity_score: 29,
    access_score: 100,
    settlement_score: 100,
    execution_certainty_score: 80,
    capacity_score: 100,
    output_asset_quality_score: 80,
    cost_score: 40,
    route_family: "basket-redeem",
    access_model: "permissionless-onchain",
    settlement_model: "atomic",
    execution_model: "deterministic-basket",
    output_asset_type: "stable-basket",
    provider: "supply-full-model",
    source_mode: "estimated",
    immediate_capacity_usd: 10_000_000,
    immediate_capacity_ratio: 1,
    fee_bps: null,
    queue_enabled: 0,
    updated_at: 1_700_000_000,
    methodology_version: "1.1",
    details_json: JSON.stringify({
      resolutionState: "resolved",
      outputDependencyResolution: {
        stablecoinId: "downstream-output",
        resolutionState: "missing-capacity",
      },
      capacityConfidence: "heuristic",
      capacitySemantics: "eventual-only",
      capacityKind: "live-proxy-validated",
      freshnessKind: "verified-source-timestamp",
      sourceTimestamp: 1_699_999_900,
      sourceUrls: ["https://example.com/redemption.json"],
      settlementDelaySec: 3600,
      queueDepthUsd: 12_000_000,
      dailyLimitUsd: 5_000_000,
      minRedeemUsd: 100_000,
      liveHolderEligibility: "whitelisted-primary",
      feeConfidence: "undisclosed-reviewed",
      feeModelKind: "undisclosed-reviewed",
      modelConfidence: "low",
      capsApplied: [],
      feeDescription: "Fixed redemption fee, but public docs do not publish the current rate",
    }),
    ...overrides,
  };
}

export const COMPLETED_RUNS_SQL =
  "SELECT run_id, completed_at, expected_count, written_count, min_updated_at, max_updated_at, methodology_version, status, metadata_json FROM redemption_backstop_runs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT ?";
export const RUN_ROWS_BY_RUN_ID_SQL =
  "SELECT stablecoin_id, score, dex_liquidity_score, access_score, settlement_score, execution_certainty_score, capacity_score, output_asset_quality_score, cost_score, route_family, access_model, settlement_model, execution_model, output_asset_type, provider, source_mode, immediate_capacity_usd, immediate_capacity_ratio, fee_bps, queue_enabled, updated_at, methodology_version, details_json, snapshot_run_id FROM redemption_backstop_run_rows WHERE snapshot_run_id = ?";

export function completedRun(run_id: string, overrides: Record<string, unknown> = {}) {
  return {
    run_id, completed_at: 1_700_000_010, expected_count: 1, written_count: 1,
    min_updated_at: 1_700_000_000, max_updated_at: 1_700_000_000, methodology_version: "1.1",
    ...overrides,
  };
}

export function makeCompletedRunsDb(
  manifests: ReturnType<typeof completedRun>[],
  rowsByRun: Record<string, ReturnType<typeof makeRedemptionRow>[]>,
) {
  return mockD1Strict([
    { match: COMPLETED_RUNS_SQL, matchBinds: [5], rows: manifests },
    ...Object.entries(rowsByRun).map(([runId, rows]) => ({
      match: RUN_ROWS_BY_RUN_ID_SQL, matchBinds: [runId], rows,
    })),
  ]);
}
