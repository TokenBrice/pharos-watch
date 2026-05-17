import { describe, expect, it } from "vitest";
import type { RedemptionBackstopEntry, RedemptionBackstopMap } from "@shared/types/redemption";
import {
  getRedemptionBackstopVersionAt,
  toRedemptionBackstopVersionLabel,
} from "@shared/lib/redemption-backstop-version";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  loadRedemptionBackstopMap,
  loadRedemptionBackstopSnapshot,
  normalizeRedemptionBackstopRunMetadata,
  RedemptionBackstopSnapshotUnavailableError,
  resolveSnapshotMethodologyVersion,
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

const LEGACY_V3997_REDEMPTION_BACKSTOP_ROW = makeRealisticRow({
  stablecoin_id: "usdc-circle",
  methodology_version: "3.997",
  details_json: JSON.stringify({
    resolutionState: "resolved",
    capacityConfidence: "documented-bound",
    capacitySemantics: "eventual-only",
    feeConfidence: "fixed",
    feeModelKind: "fixed-bps",
    modelConfidence: "medium",
    routeStatus: "open",
    routeStatusSource: "static-config",
    holderEligibility: "verified-customer",
    legacyExtraField: { keepReadersTolerant: true },
  }),
});

const LEGACY_V3997_REDEMPTION_BACKSTOP_HISTORY_ROW = {
  stablecoin_id: "usdc-circle",
  snapshot_date: 1_746_748_800,
  score: 65,
  effective_exit_score: 58,
  dex_liquidity_score: 44,
  updated_at: 1_746_800_000,
  methodology_version: "3.997",
  details_json: LEGACY_V3997_REDEMPTION_BACKSTOP_ROW.details_json,
  snapshot_run_id: "legacy-run",
};

const LEGACY_V3997_REDEMPTION_BACKSTOP_RUN_ROW = {
  run_id: "legacy-run",
  completed_at: 1_746_800_010,
  status: "completed",
  expected_count: 1,
  written_count: 1,
  min_updated_at: 1_746_800_000,
  max_updated_at: 1_746_800_000,
  methodology_version: "3.997",
  metadata_json: JSON.stringify({
    configured: 264,
    resolved: 249,
    unresolved: 15,
    legacyExtraField: "ignored by typed consumers",
  }),
};

describe("loadRedemptionBackstopMap", () => {
  it("keeps the row and drops malformed details JSON", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop",
        rows: [
          makeRealisticRow({
            stablecoin_id: "usdc-circle",
            score: 65,
            source_mode: "dynamic",
            fee_bps: 10,
            details_json: "{bad json",
          }),
        ],
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

    await expect(loadRedemptionBackstopMap(db)).rejects.toBeInstanceOf(RedemptionBackstopSnapshotUnavailableError);
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
    expect(entry!.capacityProfile).toMatchObject({
      immediateUsd: 10_000_000,
      scoringHorizon: "daily",
      capacityProfileConfidence: "heuristic",
    });
    expect(entry!.capacityKind).toBe("live-proxy-validated");
    expect(entry!.freshnessKind).toBe("verified-source-timestamp");
    expect(entry!.sourceTimestamp).toBe(1_699_999_900);
    expect(entry!.sourceUrls).toEqual(["https://example.com/redemption.json"]);
    expect(entry!.settlementDelaySec).toBe(3600);
    expect(entry!.queueDepthUsd).toBe(12_000_000);
    expect(entry!.dailyLimitUsd).toBe(5_000_000);
    expect(entry!.minRedeemUsd).toBe(100_000);
    expect(entry!.liveHolderEligibility).toBe("whitelisted-primary");
    expect(entry!.eventualRedeemabilityScore).toBe(72);
    expect(entry!.confidenceDetails?.reasons).toEqual(["heuristic capacity"]);
    expect(entry!.costScenarioScores).toEqual({ retail: 30, activeUser: 40, institutional: null });
    expect(entry!.routeExitCorrelation).toBe("independent-issuer-rail");
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
        rows: [
          makeRealisticRow({
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
          }),
        ],
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
        rows: [
          makeRealisticRow({
            stablecoin_id: "missing-coin",
            score: null,
            effective_exit_score: null,
            capacity_score: null,
            source_mode: "static",
            details_json: JSON.stringify({}),
          }),
        ],
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
        rows: [
          {
            run_id: "run-new",
            completed_at: 1_700_000_010,
            expected_count: 1,
            written_count: 1,
            min_updated_at: 1_700_000_000,
            max_updated_at: 1_700_000_000,
            methodology_version: "1.1",
          },
        ],
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

  it("falls back to an earlier completed run when the newest completed manifest is not complete", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop_runs",
        rows: [
          {
            run_id: "run-incomplete",
            completed_at: 1_700_000_010,
            expected_count: 2,
            written_count: 1,
            min_updated_at: 1_700_000_000,
            max_updated_at: 1_700_000_000,
            methodology_version: "1.1",
          },
          {
            run_id: "run-valid",
            completed_at: 1_700_000_000,
            expected_count: 1,
            written_count: 1,
            min_updated_at: 1_699_999_990,
            max_updated_at: 1_699_999_990,
            methodology_version: "1.1",
          },
        ],
      },
      {
        match: "WHERE snapshot_run_id = ?",
        matchBinds: ["run-valid"],
        rows: [makeRealisticRow({ snapshot_run_id: "run-valid", updated_at: 1_699_999_990 })],
      },
    ]);

    const result = await loadRedemptionBackstopSnapshot(db);

    expect(result.runId).toBe("run-valid");
    expect(result.latestUpdatedAt).toBe(1_699_999_990);
  });

  it("serves immutable rows from the latest completed run when the current mirror was overwritten by a failed run", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop_runs",
        rows: [
          {
            run_id: "run-old-completed",
            completed_at: 1_700_000_000,
            expected_count: 1,
            written_count: 1,
            min_updated_at: 1_699_999_990,
            max_updated_at: 1_699_999_990,
            methodology_version: "1.1",
          },
        ],
      },
      {
        match: "FROM redemption_backstop_run_rows",
        matchBinds: ["run-old-completed"],
        rows: [makeRealisticRow({ snapshot_run_id: "run-old-completed", updated_at: 1_699_999_990 })],
      },
      {
        match: "FROM redemption_backstop\n            WHERE snapshot_run_id = ?",
        matchBinds: ["run-old-completed"],
        rows: [],
        throwError: new Error("current mirror should not be read for completed run rows"),
      },
    ]);

    const result = await loadRedemptionBackstopSnapshot(db);

    expect(result.runId).toBe("run-old-completed");
    expect(result.latestUpdatedAt).toBe(1_699_999_990);
    expect(result.map["eurc-circle"]?.updatedAt).toBe(1_699_999_990);
  });

  it("rejects completed run manifests when every recent candidate is invalid", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop_runs",
        rows: [
          {
            run_id: "run-missing-row",
            completed_at: 1_700_000_010,
            expected_count: 1,
            written_count: 1,
            min_updated_at: 1_700_000_000,
            max_updated_at: 1_700_000_000,
            methodology_version: "1.1",
          },
        ],
      },
      {
        match: "WHERE snapshot_run_id = ?",
        matchBinds: ["run-missing-row"],
        rows: [],
      },
    ]);

    await expect(loadRedemptionBackstopSnapshot(db)).rejects.toThrow(
      "No valid completed redemption backstop run found",
    );
  });

  it("falls back when the newest completed run has unreadable rows", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop_runs",
        rows: [
          {
            run_id: "run-bad",
            completed_at: 1_700_000_010,
            expected_count: 1,
            written_count: 1,
            min_updated_at: 1_700_000_000,
            max_updated_at: 1_700_000_000,
            methodology_version: "1.1",
          },
          {
            run_id: "run-valid",
            completed_at: 1_700_000_000,
            expected_count: 1,
            written_count: 1,
            min_updated_at: 1_699_999_990,
            max_updated_at: 1_699_999_990,
            methodology_version: "1.1",
          },
        ],
      },
      {
        match: "WHERE snapshot_run_id = ?",
        matchBinds: ["run-bad"],
        rows: [makeRealisticRow({ snapshot_run_id: "run-bad", route_family: "bad-family" })],
      },
      {
        match: "WHERE snapshot_run_id = ?",
        matchBinds: ["run-valid"],
        rows: [makeRealisticRow({ snapshot_run_id: "run-valid", updated_at: 1_699_999_990 })],
      },
    ]);

    const result = await loadRedemptionBackstopSnapshot(db);

    expect(result.runId).toBe("run-valid");
  });

  it("drops invalid enum and collection values from details JSON before applying fallbacks", async () => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop",
        rows: [
          makeRealisticRow({
            stablecoin_id: "bad-details",
            score: 65,
            provider: "supply-full-model",
            source_mode: "estimated",
            fee_bps: null,
            details_json: JSON.stringify({
              resolutionState: "definitely-not-valid",
              capacityConfidence: "not-a-confidence",
              capacitySemantics: "unknown-semantics",
              feeConfidence: "bad-fee-confidence",
              feeModelKind: "bad-fee-kind",
              modelConfidence: "bad-model-confidence",
              routeStatus: "broken",
              routeStatusSource: "bad-source",
              holderEligibility: "nope",
              capacityProfile: { scoringHorizon: "bad", capacityProfileConfidence: "heuristic" },
              confidenceDetails: { capacityEvidenceQuality: 101 },
              capacityKind: "bad-kind",
              freshnessKind: "bad-freshness",
              sourceTimestamp: -1,
              sourceUrls: ["ftp://example.com/redemption.json"],
              settlementDelaySec: -1,
              queueDepthUsd: -1,
              dailyLimitUsd: -1,
              minRedeemUsd: -1,
              liveHolderEligibility: "not-eligible",
              eventualRedeemabilityScore: -1,
              costScenarioScores: { retail: "free" },
              routeExitCorrelation: "too-close",
              notes: ["valid", 123],
              capsApplied: ["valid-cap", false],
              docs: { url: "not-a-url" },
            }),
          }),
        ],
      },
    ]);

    const result = await loadRedemptionBackstopMap(db);
    const entry = result["bad-details"];

    expect(entry).toBeDefined();
    expect(entry!.resolutionState).toBe("resolved");
    expect(entry!.capacityConfidence).toBe("heuristic");
    expect(entry!.capacitySemantics).toBe("eventual-only");
    expect(entry!.feeConfidence).toBe("undisclosed-reviewed");
    expect(entry!.feeModelKind).toBe("undisclosed-reviewed");
    expect(entry!.modelConfidence).toBe("low");
    expect(entry!.routeStatus).toBe("unknown");
    expect(entry!.routeStatusSource).toBe("static-config");
    expect(entry!.holderEligibility).toBe("unknown");
    expect(entry!.capacityProfile).toBeUndefined();
    expect(entry!.confidenceDetails).toBeUndefined();
    expect(entry!.capacityKind).toBeUndefined();
    expect(entry!.freshnessKind).toBeUndefined();
    expect(entry!.sourceTimestamp).toBeUndefined();
    expect(entry!.sourceUrls).toBeUndefined();
    expect(entry!.settlementDelaySec).toBeUndefined();
    expect(entry!.queueDepthUsd).toBeUndefined();
    expect(entry!.dailyLimitUsd).toBeUndefined();
    expect(entry!.minRedeemUsd).toBeUndefined();
    expect(entry!.liveHolderEligibility).toBeUndefined();
    expect(entry!.eventualRedeemabilityScore).toBeUndefined();
    expect(entry!.costScenarioScores).toBeUndefined();
    expect(entry!.routeExitCorrelation).toBeUndefined();
    expect(entry!.notes).toBeUndefined();
    expect(entry!.capsApplied).toBeUndefined();
    expect(entry!.docs).toBeUndefined();
  });

  it("reads frozen v3.997 current/history/run fixture shapes without v4 optional fields", async () => {
    expect(LEGACY_V3997_REDEMPTION_BACKSTOP_HISTORY_ROW.snapshot_date).toBe(1_746_748_800);

    const db = mockD1([
      {
        match: "FROM redemption_backstop_runs",
        rows: [LEGACY_V3997_REDEMPTION_BACKSTOP_RUN_ROW],
      },
      {
        match: "WHERE snapshot_run_id = ?",
        matchBinds: ["legacy-run"],
        rows: [LEGACY_V3997_REDEMPTION_BACKSTOP_ROW],
      },
    ]);

    const result = await loadRedemptionBackstopSnapshot(db);
    const entry = result.map["usdc-circle"];

    expect(result.runId).toBe("legacy-run");
    expect(result.latestUpdatedAt).toBe(1_746_800_000);
    expect(entry).toMatchObject({
      stablecoinId: "usdc-circle",
      methodologyVersion: "3.997",
      resolutionState: "resolved",
      routeStatus: "open",
      routeStatusSource: "static-config",
    });
    expect(entry.capacityProfile).toBeUndefined();
    expect(entry.confidenceDetails).toBeUndefined();
    expect(entry.routeExitCorrelation).toBeUndefined();
  });

  it("normalizes run metadata for completed, running, failed, and legacy manifests", () => {
    expect(
      normalizeRedemptionBackstopRunMetadata(LEGACY_V3997_REDEMPTION_BACKSTOP_RUN_ROW.metadata_json),
    ).toMatchObject({
      configured: 264,
      resolved: 249,
      unresolved: 15,
    });
    expect(
      normalizeRedemptionBackstopRunMetadata(
        JSON.stringify({
          registryHash: "abc123",
          familyCounts: { "offchain-issuer": 124, broken: "many" },
          strongProxyCount: 249,
          heuristicCount: 15,
          validatorVersion: 4,
          configMethodologyVersion: "4.0",
          v4ScoringParametersHash: "def456",
          routeStatusProducer: "live-reserve-adapters-plus-static-policy",
          routeStatusProducerFetches: false,
          failure: { message: "boom" },
        }),
      ),
    ).toMatchObject({
      registryHash: "abc123",
      familyCounts: { "offchain-issuer": 124 },
      strongProxyCount: 249,
      heuristicCount: 15,
      validatorVersion: 4,
      configMethodologyVersion: "4.0",
      v4ScoringParametersHash: "def456",
      routeStatusProducer: "live-reserve-adapters-plus-static-policy",
      routeStatusProducerFetches: false,
    });
    expect(normalizeRedemptionBackstopRunMetadata("not-json")).toEqual({});
    expect(normalizeRedemptionBackstopRunMetadata(null)).toEqual({});
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
    expect(
      history.some(
        (entry) => entry.sql.includes("INSERT INTO redemption_backstop_run_rows") && entry.binds.includes("run-test"),
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) => entry.sql.includes("INSERT INTO redemption_backstop") && entry.binds.includes("run-test"),
      ),
    ).toBe(true);
    expect(
      history.some(
        (entry) =>
          entry.sql.includes("INSERT OR REPLACE INTO redemption_backstop_history") && entry.binds.includes("run-test"),
      ),
    ).toBe(true);
  });

  it("marks a started run as failed when row writes fail", async () => {
    const db = mockD1([
      {
        match: "redemption_backstop_history",
        rows: [],
        throwError: new Error("history write failed"),
      },
    ]);
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

    await expect(
      upsertRedemptionBackstopSnapshots(db, [record], {
        runId: "run-fails",
        expectedCount: 1,
      }),
    ).rejects.toThrow("history write failed");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("status = 'failed'") && entry.binds.includes("run-fails"))).toBe(
      true,
    );
  });
});

describe("resolveSnapshotMethodologyVersion", () => {
  function makeMapEntry(updatedAt: number, methodologyVersion: string): RedemptionBackstopEntry {
    return {
      updatedAt,
      methodologyVersion,
    } as unknown as RedemptionBackstopEntry;
  }

  it("returns the matching entry's methodology version when an entry's updatedAt matches", () => {
    const coins: RedemptionBackstopMap = {
      "a-coin": makeMapEntry(1_700_000_000, "1.1"),
      "b-coin": makeMapEntry(1_750_000_000, "3.97"),
    };

    const result = resolveSnapshotMethodologyVersion(coins, 1_750_000_000);

    expect(result.version).toBe("3.97");
    expect(result.versionLabel).toBe(toRedemptionBackstopVersionLabel("3.97"));
  });

  it("falls back to getRedemptionBackstopVersionAt when no entry matches the updatedAt", () => {
    const coins: RedemptionBackstopMap = {
      "a-coin": makeMapEntry(1_700_000_000, "1.1"),
    };
    const queryAt = 1_500_000_000;
    const expectedVersion = getRedemptionBackstopVersionAt(queryAt);

    const result = resolveSnapshotMethodologyVersion(coins, queryAt);

    expect(result.version).toBe(expectedVersion);
    expect(result.versionLabel).toBe(toRedemptionBackstopVersionLabel(expectedVersion));
  });

  it("falls back to getRedemptionBackstopVersionAt when updatedAt is zero", () => {
    const coins: RedemptionBackstopMap = {
      "a-coin": makeMapEntry(1_700_000_000, "1.1"),
    };
    const expectedVersion = getRedemptionBackstopVersionAt(0);

    const result = resolveSnapshotMethodologyVersion(coins, 0);

    expect(result.version).toBe(expectedVersion);
    expect(result.versionLabel).toBe(toRedemptionBackstopVersionLabel(expectedVersion));
  });
});
