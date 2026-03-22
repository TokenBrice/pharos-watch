import { describe, expect, it } from "vitest";
import { mockD1 } from "./helpers/mock-d1";
import { handleRedemptionBackstops } from "../redemption-backstops";

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
        rows: [
          {
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
            updated_at: updatedAt,
            methodology_version: "1.1",
            details_json: JSON.stringify({
              resolutionState: "resolved",
              capacityConfidence: "heuristic",
              capacitySemantics: "eventual-only",
              feeConfidence: "undisclosed-reviewed",
              feeModelKind: "undisclosed-reviewed",
              modelConfidence: "low",
              capsApplied: [],
              feeDescription: "Fixed redemption fee, but public docs do not publish the current rate",
            }),
          },
        ],
      },
    ]);

    const response = await handleRedemptionBackstops(db);
    expect(response.status).toBe(200);

    const body = await response.json() as {
      coins: Record<
        string,
        {
          score: number;
          effectiveExitScore: number;
          feeDescription?: string;
          resolutionState: string;
          modelConfidence: string;
        }
      >;
      methodology: { version: string };
      updatedAt: number;
    };

    expect(body.updatedAt).toBe(updatedAt);
    expect(body.methodology.version).toBe("1.4");
    expect(body.coins["cusd-cap"]?.effectiveExitScore).toBe(56);
    expect(body.coins["cusd-cap"]?.resolutionState).toBe("resolved");
    expect(body.coins["cusd-cap"]?.modelConfidence).toBe("low");
    expect(body.coins["cusd-cap"]?.feeDescription).toContain("Fixed redemption fee");
  });
});
