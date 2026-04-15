import { describe, expect, it } from "vitest";
import type { RedemptionBackstopEntry } from "@shared/types/redemption";
import { mockD1 } from "../../api/__tests__/helpers/mock-d1";
import {
  loadRedemptionBackstopMap,
  loadRedemptionBackstopSnapshot,
  RedemptionBackstopSnapshotUnavailableError,
  upsertRedemptionBackstopSnapshots,
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
      routeStatus: "open",
      routeStatusSource: "static-config",
      holderEligibility: "verified-customer",
      capsApplied: ["offchain-route-cap"],
      feeDescription: "EEA burn fee is 0 bps; other Circle redemption fees may vary",
      docs: { label: "Reserve feed", url: "https://example.com/reserves", provenance: "proof-of-reserves" },
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
    expect(result["usdc-circle"]?.capacityConfidence).toBe("heuristic");
    expect(result["usdc-circle"]?.capacitySemantics).toBe("eventual-only");
    expect(result["usdc-circle"]?.feeConfidence).toBe("fixed");
    expect(result["usdc-circle"]?.feeModelKind).toBe("fixed-bps");
    expect(result["usdc-circle"]?.modelConfidence).toBe("low");
    expect(result["usdc-circle"]?.routeStatus).toBe("unknown");
    expect(result["usdc-circle"]?.routeStatusSource).toBe("static-config");
    expect(result["usdc-circle"]?.holderEligibility).toBe("unknown");
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
    expect(entry!.routeStatus).toBe("open");
    expect(entry!.routeStatusSource).toBe("static-config");
    expect(entry!.holderEligibility).toBe("verified-customer");
    expect(entry!.capsApplied).toEqual(["offchain-route-cap"]);
    expect(entry!.feeDescription).toBe("EEA burn fee is 0 bps; other Circle redemption fees may vary");
    expect(entry!.docs).toEqual({
      label: "Reserve feed",
      url: "https://example.com/reserves",
      provenance: "proof-of-reserves",
    });
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
    expect(entry!.routeStatus).toBe("unknown");
    expect(entry!.routeStatusSource).toBe("static-config");
    expect(entry!.holderEligibility).toBe("unknown");
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

  it("prefers the latest completed run when loading a snapshot", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop_runs",
        rows: [],
        first: {
          run_id: "run-new",
          completed_at: 1_700_000_010,
          expected_count: 1,
          written_count: 1,
          min_updated_at: 1_700_000_000,
          max_updated_at: 1_700_000_000,
          methodology_version: "1.1",
        },
      },
      {
        match: "WHERE snapshot_run_id = ?",
        matchBinds: ["run-new"],
        rows: [makeRealisticRow({ snapshot_run_id: "run-new" })],
      },
      {
        match: "MAX(updated_at)",
        rows: [],
        throwError: new Error("legacy path should not be used"),
      },
    ]);

    const result = await loadRedemptionBackstopSnapshot(db);

    expect(result.runId).toBe("run-new");
    expect(result.latestUpdatedAt).toBe(1_700_000_000);
    expect(Object.keys(result.map)).toEqual(["eurc-circle"]);
  });

  it("writes current/history rows under a completed run manifest", async () => {
    const db = mockD1();
    const record: RedemptionBackstopEntry = {
      stablecoinId: "eurc-circle",
      score: 65,
      effectiveExitScore: 58,
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
    };

    await upsertRedemptionBackstopSnapshots(db, [record], {
      runId: "run-test",
      expectedCount: 1,
      metadata: { configured: 1 },
    });

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO redemption_backstop_runs"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("UPDATE redemption_backstop_runs"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("INSERT INTO redemption_backstop") && entry.binds.includes("run-test"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("INSERT OR REPLACE INTO redemption_backstop_history") && entry.binds.includes("run-test"))).toBe(true);
  });
});
