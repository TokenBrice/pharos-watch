import { describe, expect, it } from "vitest";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import {
  loadRedemptionBackstopMap,
  RedemptionBackstopSnapshotUnavailableError,
} from "../redemption-backstops-store";

/** Realistic mock row matching an actual offchain-issuer config (EURC). */
function makeRealisticRow(overrides: Record<string, unknown> = {}) {
  return {
    stablecoin_id: "eurc-circle",
    score: 65,
    effective_exit_score: 58,
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
      capsApplied: ["offchain-route-cap"],
      feeDescription: "EEA burn fee is 0 bps; other Circle redemption fees may vary",
      docs: { label: "Reserve feed", url: "https://example.com/reserves" },
      notes: ["Some note"],
    }),
    ...overrides,
  };
}

describe("loadRedemptionBackstopMap", () => {
  it("keeps the row and drops malformed details JSON", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop",
        rows: [makeRealisticRow({
          stablecoin_id: "usdc-circle",
          score: 65,
          source_mode: "dynamic",
          fee_bps: 10,
          details_json: "{bad json",
        })],
      },
    ]);

    const result = await loadRedemptionBackstopMap(db);

    expect(result["usdc-circle"]).toMatchObject({
      stablecoinId: "usdc-circle",
      score: 65,
      routeFamily: "offchain-issuer",
    });
    expect(result["usdc-circle"]?.docs).toBeUndefined();
    expect(result["usdc-circle"]?.notes).toBeUndefined();
    expect(result["usdc-circle"]?.capsApplied).toBeUndefined();
    expect(result["usdc-circle"]?.feeDescription).toBeUndefined();
    // Inferred from row columns when details_json is malformed
    expect(result["usdc-circle"]?.resolutionState).toBe("resolved");
    expect(result["usdc-circle"]?.capacityConfidence).toBe("dynamic");
    expect(result["usdc-circle"]?.capacitySemantics).toBe("eventual-only");
    expect(result["usdc-circle"]?.feeConfidence).toBe("fixed");
    expect(result["usdc-circle"]?.feeModelKind).toBe("fixed-bps");
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

  it("round-trips details JSON fields through serialize → deserialize", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop",
        rows: [makeRealisticRow()],
      },
    ]);

    const result = await loadRedemptionBackstopMap(db);
    const entry = result["eurc-circle"];

    expect(entry).toBeDefined();
    expect(entry!.resolutionState).toBe("resolved");
    expect(entry!.capacityConfidence).toBe("heuristic");
    expect(entry!.capacitySemantics).toBe("eventual-only");
    expect(entry!.feeConfidence).toBe("undisclosed-reviewed");
    expect(entry!.feeModelKind).toBe("undisclosed-reviewed");
    expect(entry!.modelConfidence).toBe("low");
    expect(entry!.capsApplied).toEqual(["offchain-route-cap"]);
    expect(entry!.feeDescription).toBe("EEA burn fee is 0 bps; other Circle redemption fees may vary");
    expect(entry!.docs).toEqual({ label: "Reserve feed", url: "https://example.com/reserves" });
    expect(entry!.notes).toEqual(["Some note"]);
  });

  it("infers confidence from row columns when details_json omits them", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop",
        rows: [makeRealisticRow({
          stablecoin_id: "dai-makerdao",
          score: 85,
          source_mode: "estimated",
          provider: "supply-ratio-model",
          fee_bps: 0,
          details_json: JSON.stringify({
            resolutionState: "resolved",
            // No capacityConfidence, feeConfidence, or modelConfidence
            capsApplied: [],
          }),
        })],
      },
    ]);

    const result = await loadRedemptionBackstopMap(db);
    const entry = result["dai-makerdao"];

    expect(entry).toBeDefined();
    expect(entry!.capacityConfidence).toBe("heuristic");
    expect(entry!.capacitySemantics).toBe("immediate-bounded");
    expect(entry!.feeConfidence).toBe("fixed");
    expect(entry!.feeModelKind).toBe("fixed-bps");
    expect(entry!.modelConfidence).toBe("low");
  });

  it("infers missing-capacity resolution when score is null and details omit resolutionState", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop",
        rows: [makeRealisticRow({
          stablecoin_id: "missing-coin",
          score: null,
          effective_exit_score: null,
          capacity_score: null,
          source_mode: "static",
          details_json: JSON.stringify({}),
        })],
      },
    ]);

    const result = await loadRedemptionBackstopMap(db);
    const entry = result["missing-coin"];

    expect(entry).toBeDefined();
    expect(entry!.resolutionState).toBe("missing-capacity");
    expect(entry!.score).toBeNull();
  });
});
