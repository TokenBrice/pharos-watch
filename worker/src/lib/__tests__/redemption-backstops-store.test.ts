import { describe, expect, it } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import {
  loadRedemptionBackstopMap,
  RedemptionBackstopSnapshotUnavailableError,
} from "../redemption-backstops-store";

describe("loadRedemptionBackstopMap", () => {
  it("keeps the row and drops malformed details JSON", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop",
        rows: [{
          stablecoin_id: "usdc-circle",
          score: 88,
          effective_exit_score: 90,
          dex_liquidity_score: 85,
          access_score: 92,
          settlement_score: 95,
          execution_certainty_score: 91,
          capacity_score: 84,
          output_asset_quality_score: 93,
          cost_score: 80,
          route_family: "offchain-issuer",
          access_model: "issuer-api",
          settlement_model: "immediate",
          execution_model: "opaque",
          output_asset_type: "nav",
          provider: "Circle",
          source_mode: "dynamic",
          immediate_capacity_usd: 500_000_000,
          immediate_capacity_ratio: 0.5,
          fee_bps: 10,
          queue_enabled: 0,
          updated_at: 1_700_000_000,
          methodology_version: "2026-03-01",
          details_json: "{bad json",
        }],
      },
    ]);

    const result = await loadRedemptionBackstopMap(db);

    expect(result["usdc-circle"]).toMatchObject({
      stablecoinId: "usdc-circle",
      score: 88,
      provider: "Circle",
      routeFamily: "offchain-issuer",
    });
    expect(result["usdc-circle"]?.docs).toBeUndefined();
    expect(result["usdc-circle"]?.notes).toBeUndefined();
    expect(result["usdc-circle"]?.capsApplied).toBeUndefined();
    expect(result["usdc-circle"]?.feeDescription).toBeUndefined();
    expect(result["usdc-circle"]?.resolutionState).toBe("resolved");
    expect(result["usdc-circle"]?.capacityConfidence).toBe("dynamic");
    expect(result["usdc-circle"]?.feeConfidence).toBe("fixed");
    expect(result["usdc-circle"]?.modelConfidence).toBe("high");
  });

  it("throws a typed error when the current map query fails", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop",
        rows: [],
        throwError: new Error("d1 unavailable"),
      },
    ]);

    await expect(loadRedemptionBackstopMap(db)).rejects.toBeInstanceOf(
      RedemptionBackstopSnapshotUnavailableError,
    );
  });
});
