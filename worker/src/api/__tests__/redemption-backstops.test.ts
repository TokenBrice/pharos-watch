import { describe, expect, it } from "vitest";
import { RedemptionBackstopsResponseSchema } from "@shared/types/redemption";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import { handleRedemptionBackstops } from "../redemption-backstops";

function makeRedemptionRow(overrides: Record<string, unknown> = {}) {
  return {
    stablecoin_id: "cusd-cap",
    score: 88,
    effective_exit_score: 56,
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

describe("handleRedemptionBackstops", () => {
  it("returns 503 when the current snapshot cannot be read", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop",
        rows: [],
        throwError: new Error("db unavailable"),
      },
      {
        match: "SELECT MAX(updated_at) AS updated_at FROM redemption_backstop",
        rows: [],
        first: { updated_at: 1_700_000_000 },
      },
    ]);

    const response = await handleRedemptionBackstops(db);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Redemption backstop snapshot unavailable",
    });
  });

  it("returns 503 when no current snapshot exists", async () => {
    const db = mockD1([
      {
        match: "SELECT MAX(updated_at) AS updated_at FROM redemption_backstop",
        rows: [],
        first: { updated_at: null },
      },
      {
        match: "FROM redemption_backstop",
        rows: [],
      },
    ]);

    const response = await handleRedemptionBackstops(db);
    expect(response.status).toBe(503);
  });

  it("returns the current redemption backstop map and methodology", async () => {
    const updatedAt = 1_700_000_000;
    const db = mockD1([
      {
        match: "SELECT MAX(updated_at) AS updated_at FROM redemption_backstop",
        rows: [],
        first: { updated_at: updatedAt },
      },
      {
        match: "FROM redemption_backstop",
        rows: [makeRedemptionRow({ updated_at: updatedAt })],
      },
    ]);

    const response = await handleRedemptionBackstops(db);
    expect(response.status).toBe(200);

    const rawBody = await response.json();
    const parsed = RedemptionBackstopsResponseSchema.safeParse(rawBody);
    expect(parsed.success).toBe(true);
    const body = rawBody as {
      coins: Record<
        string,
        {
          score: number;
          effectiveExitScore: number;
          feeDescription?: string;
          resolutionState: string;
          modelConfidence: string;
          capacityKind?: string;
        }
      >;
      methodology: { version: string };
      updatedAt: number;
    };

    expect(body.updatedAt).toBe(updatedAt);
    expect(body.methodology.version).toBe("1.1");
    expect(body.coins["cusd-cap"]?.effectiveExitScore).toBe(56);
    expect(body.coins["cusd-cap"]?.resolutionState).toBe("resolved");
    expect(body.coins["cusd-cap"]?.modelConfidence).toBe("low");
    expect(body.coins["cusd-cap"]?.capacityKind).toBe("live-proxy-validated");
    expect(body.coins["cusd-cap"]?.feeDescription).toContain("Fixed redemption fee");
  });

  it("serves an earlier valid completed run when the newest completed run is invalid", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop_runs",
        rows: [{
          run_id: "run-new-bad",
          completed_at: 1_700_000_010,
          expected_count: 2,
          written_count: 1,
          min_updated_at: 1_700_000_000,
          max_updated_at: 1_700_000_000,
          methodology_version: "1.1",
        }, {
          run_id: "run-old-valid",
          completed_at: 1_700_000_000,
          expected_count: 1,
          written_count: 1,
          min_updated_at: 1_699_999_990,
          max_updated_at: 1_699_999_990,
          methodology_version: "1.1",
        }],
      },
      {
        match: "WHERE snapshot_run_id = ?",
        matchBinds: ["run-old-valid"],
        rows: [makeRedemptionRow({
          snapshot_run_id: "run-old-valid",
          updated_at: 1_699_999_990,
        })],
      },
      {
        match: "MAX(updated_at)",
        rows: [],
        throwError: new Error("legacy path should not be used"),
      },
    ]);

    const response = await handleRedemptionBackstops(db);
    expect(response.status).toBe(200);
    const rawBody = await response.json();
    const parsed = RedemptionBackstopsResponseSchema.safeParse(rawBody);

    expect(parsed.success).toBe(true);
    expect(parsed.success ? parsed.data.updatedAt : null).toBe(1_699_999_990);
    expect(parsed.success ? parsed.data.coins["cusd-cap"]?.updatedAt : null).toBe(1_699_999_990);
  });
});
