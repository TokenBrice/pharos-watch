import { describe, expect, it } from "vitest";
import type { RedemptionBackstopEntry, RedemptionBackstopMap } from "@shared/types/redemption";
import {
  getRedemptionBackstopVersionAt,
  toRedemptionBackstopVersionLabel,
} from "@shared/lib/redemption-backstop-version";
import { assertAllD1MatchesUsed, mockD1, mockD1Strict } from "../../test-helpers/__shared/mock-d1";
import { createSqliteD1 } from "../../test-helpers/sqlite-d1";
import {
  buildRedemptionBackstopsSnapshot,
  loadLegacyRedemptionBackstopCurrentMap,
  loadRedemptionBackstopSnapshot,
  normalizeRedemptionBackstopRunMetadata,
  RedemptionBackstopSnapshotUnavailableError,
  resolveSnapshotMethodologyVersion,
  upsertRedemptionBackstopSnapshots,
} from "../redemption-backstops-store";
import { pruneRedemptionBackstopRunRetention } from "../redemption-backstops-store-write";

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

const COMPLETED_RUNS_SQL =
  "SELECT run_id, completed_at, expected_count, written_count, min_updated_at, max_updated_at, methodology_version, status, metadata_json FROM redemption_backstop_runs WHERE status = 'completed' ORDER BY completed_at DESC LIMIT ?";
const ANY_RUN_MANIFEST_SQL = "SELECT run_id FROM redemption_backstop_runs LIMIT 1";
const ANY_MANIFESTED_CURRENT_ROW_SQL =
  "SELECT stablecoin_id FROM redemption_backstop WHERE snapshot_run_id IS NOT NULL LIMIT 1";
const CURRENT_ROWS_SQL =
  "SELECT stablecoin_id, score, effective_exit_score, dex_liquidity_score, access_score, settlement_score, execution_certainty_score, capacity_score, output_asset_quality_score, cost_score, route_family, access_model, settlement_model, execution_model, output_asset_type, provider, source_mode, immediate_capacity_usd, immediate_capacity_ratio, fee_bps, queue_enabled, updated_at, methodology_version, details_json, snapshot_run_id FROM redemption_backstop";
const CURRENT_ROWS_BY_RUN_ID_SQL = `${CURRENT_ROWS_SQL} WHERE snapshot_run_id = ?`;
const RUN_ROWS_BY_RUN_ID_SQL =
  "SELECT stablecoin_id, score, effective_exit_score, dex_liquidity_score, access_score, settlement_score, execution_certainty_score, capacity_score, output_asset_quality_score, cost_score, route_family, access_model, settlement_model, execution_model, output_asset_type, provider, source_mode, immediate_capacity_usd, immediate_capacity_ratio, fee_bps, queue_enabled, updated_at, methodology_version, details_json, snapshot_run_id FROM redemption_backstop_run_rows WHERE snapshot_run_id = ?";

function makeWriteRecord(overrides: Partial<RedemptionBackstopEntry> = {}): RedemptionBackstopEntry {
  return {
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
    ...overrides,
  };
}

describe("loadLegacyRedemptionBackstopCurrentMap", () => {
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

    const result = await loadLegacyRedemptionBackstopCurrentMap(db);

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

    await expect(loadLegacyRedemptionBackstopCurrentMap(db)).rejects.toBeInstanceOf(
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

    const result = await loadLegacyRedemptionBackstopCurrentMap(db);
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

    const result = await loadLegacyRedemptionBackstopCurrentMap(db);
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

    const result = await loadLegacyRedemptionBackstopCurrentMap(db);
    const entry = result["missing-coin"];

    expect(entry).toBeDefined();
    expect(entry!.resolutionState).toBe("missing-capacity");
    expect(entry!.score).toBeNull();
  });

  it.each<[string, Record<string, unknown>]>([
    ["negative score", { score: -1 }],
    ["score above 100", { score: 101 }],
    ["negative immediate capacity", { immediate_capacity_usd: -1 }],
    ["immediate capacity ratio above 1", { immediate_capacity_ratio: 1.01 }],
    ["negative fee bps", { fee_bps: -1 }],
    ["negative updated timestamp", { updated_at: -1 }],
  ])("rejects malformed numeric row values (%s)", async (_label, overrides) => {
    const db = mockD1([
      {
        match: "FROM redemption_backstop",
        rows: [makeRealisticRow(overrides)],
      },
    ]);

    await expect(loadLegacyRedemptionBackstopCurrentMap(db)).rejects.toBeInstanceOf(
      RedemptionBackstopSnapshotUnavailableError,
    );
  });

  it("prefers the latest completed run when loading a snapshot", async () => {
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
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
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-new"],
        rows: [makeRealisticRow({ snapshot_run_id: "run-new" })],
      },
    ]);

    const result = await loadRedemptionBackstopSnapshot(db);

    expect(result.runId).toBe("run-new");
    expect(result.latestUpdatedAt).toBe(1_700_000_000);
    expect(result.methodologyVersion).toBe("1.1");
    expect(Object.keys(result.map)).toEqual(["eurc-circle"]);
    assertAllD1MatchesUsed(db);
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

  it("falls back to an earlier completed run when the newest completed manifest has no max timestamp", async () => {
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
        rows: [
          {
            run_id: "run-missing-max",
            completed_at: 1_700_000_010,
            expected_count: 1,
            written_count: 1,
            min_updated_at: 1_700_000_000,
            max_updated_at: null,
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
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-valid"],
        rows: [makeRealisticRow({ snapshot_run_id: "run-valid", updated_at: 1_699_999_990 })],
      },
    ]);

    const result = await loadRedemptionBackstopSnapshot(db);

    expect(result.runId).toBe("run-valid");
    expect(result.latestUpdatedAt).toBe(1_699_999_990);
    assertAllD1MatchesUsed(db);
  });

  it("serves immutable rows from the latest completed run when the current mirror was overwritten by a failed run", async () => {
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
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
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-old-completed"],
        rows: [makeRealisticRow({ snapshot_run_id: "run-old-completed", updated_at: 1_699_999_990 })],
      },
    ]);

    const result = await loadRedemptionBackstopSnapshot(db);

    expect(result.runId).toBe("run-old-completed");
    expect(result.latestUpdatedAt).toBe(1_699_999_990);
    expect(result.map["eurc-circle"]?.updatedAt).toBe(1_699_999_990);
    assertAllD1MatchesUsed(db);
  });

  it("rejects completed run manifests when every recent candidate is invalid", async () => {
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
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
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-missing-row"],
        rows: [],
      },
      {
        match: CURRENT_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-missing-row"],
        rows: [],
      },
    ]);

    await expect(loadRedemptionBackstopSnapshot(db)).rejects.toThrow(
      "No valid completed redemption backstop run found",
    );
    assertAllD1MatchesUsed(db);
  });

  it("falls back when the newest completed run has unreadable rows", async () => {
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
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
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-bad"],
        rows: [makeRealisticRow({ snapshot_run_id: "run-bad", route_family: "bad-family" })],
      },
      {
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-valid"],
        rows: [makeRealisticRow({ snapshot_run_id: "run-valid", updated_at: 1_699_999_990 })],
      },
    ]);

    const result = await loadRedemptionBackstopSnapshot(db);

    expect(result.runId).toBe("run-valid");
    assertAllD1MatchesUsed(db);
  });

  it("does not serve partial manifested current rows when the first manifested run failed", async () => {
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
        rows: [],
      },
      {
        match: ANY_RUN_MANIFEST_SQL,
        rows: [{ run_id: "run-failed" }],
      },
      {
        match: ANY_MANIFESTED_CURRENT_ROW_SQL,
        rows: [{ stablecoin_id: "eurc-circle" }],
      },
    ]);

    await expect(loadRedemptionBackstopSnapshot(db)).rejects.toThrow(
      "No completed redemption backstop run found for manifested current rows",
    );
    assertAllD1MatchesUsed(db);
  });

  it("uses the completed run manifest methodology version for snapshot attribution", async () => {
    const db = mockD1Strict([
      {
        match: COMPLETED_RUNS_SQL,
        matchBinds: [5],
        rows: [
          {
            run_id: "run-v404",
            completed_at: 1_700_000_010,
            expected_count: 1,
            written_count: 1,
            min_updated_at: 1_700_000_000,
            max_updated_at: 1_700_000_000,
            methodology_version: "4.04",
          },
        ],
      },
      {
        match: RUN_ROWS_BY_RUN_ID_SQL,
        matchBinds: ["run-v404"],
        rows: [makeRealisticRow({ snapshot_run_id: "run-v404", methodology_version: "4.03" })],
      },
    ]);

    const result = await buildRedemptionBackstopsSnapshot(db);

    expect(result.methodology.version).toBe("4.04");
    expect(result.methodology.versionLabel).toBe("v4.04");
    expect(result.coins["eurc-circle"]?.methodologyVersion).toBe("4.03");
    assertAllD1MatchesUsed(db);
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

    const result = await loadLegacyRedemptionBackstopCurrentMap(db);
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
    const db = mockD1([
      {
        match: "COUNT(*) AS row_count",
        rows: [],
        first: { row_count: 1, min_updated_at: 1_700_000_000, max_updated_at: 1_700_000_000 },
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

    const result = await upsertRedemptionBackstopSnapshots(db, [record], {
      runId: "run-test",
      expectedCount: 1,
      metadata: { configured: 1 },
    });

    expect(result).toMatchObject({
      runId: "run-test",
      attemptedCount: 1,
      runRowsWrittenCount: 1,
      historyWrittenCount: 1,
      currentMirroredCount: 1,
      warnings: [],
    });
    const history = db.getHistory();
    const runStartIndex = history.findIndex((entry) => entry.sql.includes("INSERT INTO redemption_backstop_runs"));
    const runRowIndex = history.findIndex((entry) => entry.sql.includes("INSERT INTO redemption_backstop_run_rows"));
    const historyRowIndex = history.findIndex((entry) =>
      entry.sql.includes("INSERT OR REPLACE INTO redemption_backstop_history"),
    );
    const completeIndex = history.findIndex((entry) => entry.sql.includes("status = 'completed'"));
    const currentMirrorIndex = history.findIndex((entry) => entry.sql.includes("INSERT INTO redemption_backstop ("));
    expect(runStartIndex).toBeGreaterThanOrEqual(0);
    expect(runRowIndex).toBeGreaterThan(runStartIndex);
    expect(historyRowIndex).toBeGreaterThan(runRowIndex);
    expect(completeIndex).toBeGreaterThan(historyRowIndex);
    expect(currentMirrorIndex).toBeGreaterThan(completeIndex);
    const runRowInsert = history.find(
      (entry) => entry.sql.includes("INSERT INTO redemption_backstop_run_rows") && entry.binds.includes("run-test"),
    );
    const currentMirrorInsert = history.find(
      (entry) => entry.sql.includes("INSERT INTO redemption_backstop (") && entry.binds.includes("run-test"),
    );
    expect(runRowInsert?.binds).toHaveLength(25);
    expect(currentMirrorInsert?.binds).toHaveLength(25);
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
    const metadataUpdates = history.filter((entry) => entry.sql.includes("SET metadata_json = ?"));
    const finalMetadataUpdate = metadataUpdates[metadataUpdates.length - 1];
    const finalMetadata = JSON.parse(String(finalMetadataUpdate?.binds[0] ?? "{}")) as Record<string, unknown>;
    expect(finalMetadata).toMatchObject({
      configured: 1,
      snapshotRunId: "run-test",
      attemptedCount: 1,
      runRowsWrittenCount: 1,
      historyWrittenCount: 1,
      currentMirroredCount: 1,
      writeStatus: "completed",
    });
  });

  it("marks a started run as failed when row writes fail", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) AS row_count",
        rows: [],
        first: { row_count: 1, min_updated_at: 1_700_000_000, max_updated_at: 1_700_000_000 },
      },
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
    const failedUpdate = history.find((entry) => entry.sql.includes("status = 'failed'"));
    const failedMetadata = JSON.parse(String(failedUpdate?.binds[2] ?? "{}")) as Record<string, unknown>;
    expect(failedMetadata).toMatchObject({
      snapshotRunId: "run-fails",
      attemptedCount: 1,
      runRowsWrittenCount: 1,
      historyWrittenCount: 0,
      currentMirroredCount: 0,
      writeStatus: "failed",
      writePhase: "history",
    });
  });

  it("marks a started run as failed when immutable run rows are incomplete", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) AS row_count",
        rows: [],
        first: { row_count: 1, min_updated_at: 1_700_000_000, max_updated_at: 1_700_000_000 },
      },
    ]);
    const records = [
      makeWriteRecord({ stablecoinId: "eurc-circle" }),
      makeWriteRecord({ stablecoinId: "usdc-circle" }),
    ];

    await expect(
      upsertRedemptionBackstopSnapshots(db, records, {
        runId: "run-partial",
        expectedCount: 2,
      }),
    ).rejects.toThrow("wrote 1/2 immutable rows");

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("INSERT INTO redemption_backstop ("))).toBe(false);
    const failedUpdate = history.find((entry) => entry.sql.includes("status = 'failed'"));
    const failedMetadata = JSON.parse(String(failedUpdate?.binds[2] ?? "{}")) as Record<string, unknown>;
    expect(failedMetadata).toMatchObject({
      snapshotRunId: "run-partial",
      attemptedCount: 2,
      writeStatus: "failed",
      writePhase: "run-rows",
    });
  });

  it("keeps the immutable completed run when the legacy current mirror fails", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) AS row_count",
        rows: [],
        first: { row_count: 1, min_updated_at: 1_700_000_000, max_updated_at: 1_700_000_000 },
      },
      {
        match: "INSERT INTO redemption_backstop (",
        rows: [],
        throwError: new Error("current mirror failed"),
      },
    ]);

    const result = await upsertRedemptionBackstopSnapshots(db, [makeWriteRecord()], {
      runId: "run-current-warning",
      expectedCount: 1,
    });

    expect(result).toMatchObject({
      runId: "run-current-warning",
      runRowsWrittenCount: 1,
      historyWrittenCount: 1,
      currentMirroredCount: 0,
    });
    expect(result.warnings[0]).toContain("Current mirror update failed");
    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("status = 'completed'"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("status = 'failed'"))).toBe(false);
    const metadataUpdates = history.filter((entry) => entry.sql.includes("SET metadata_json = ?"));
    const warningMetadataUpdate = metadataUpdates.find((entry) => {
      const metadata = JSON.parse(String(entry.binds[0] ?? "{}")) as Record<string, unknown>;
      return metadata.writePhase === "current-mirror";
    });
    const warningMetadata = JSON.parse(String(warningMetadataUpdate?.binds[0] ?? "{}")) as Record<string, unknown>;
    expect(warningMetadata).toMatchObject({
      snapshotRunId: "run-current-warning",
      writeStatus: "completed-with-warnings",
      writePhase: "current-mirror",
      writeWarnings: [expect.stringContaining("current mirror failed")],
    });
    const finalMetadata = JSON.parse(String(metadataUpdates[metadataUpdates.length - 1]?.binds[0] ?? "{}")) as Record<
      string,
      unknown
    >;
    expect(finalMetadata).toMatchObject({
      snapshotRunId: "run-current-warning",
      writeStatus: "completed-with-warnings",
      writePhase: "retention",
      writeWarnings: [expect.stringContaining("current mirror failed")],
    });
  });

  it("prunes old run rows and manifests while preserving the current and latest completed runs", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE redemption_backstop_runs (
          run_id TEXT PRIMARY KEY,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
          expected_count INTEGER NOT NULL,
          written_count INTEGER NOT NULL DEFAULT 0,
          methodology_version TEXT NOT NULL,
          min_updated_at INTEGER,
          max_updated_at INTEGER,
          metadata_json TEXT
        );
        CREATE TABLE redemption_backstop_run_rows (
          snapshot_run_id TEXT NOT NULL,
          stablecoin_id TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (snapshot_run_id, stablecoin_id)
        );
      `);
      const insertRun = sqlite.prepare(
        `INSERT INTO redemption_backstop_runs (
          run_id, started_at, completed_at, status, expected_count, written_count,
          methodology_version, min_updated_at, max_updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, 1, 1, '4.04', ?, ?, NULL)`,
      );
      const insertRunRow = sqlite.prepare(
        "INSERT INTO redemption_backstop_run_rows (snapshot_run_id, stablecoin_id, updated_at) VALUES (?, ?, ?)",
      );
      const nowSec = 10_000;
      const retentionSec = 1_000;
      const cutoff = nowSec - retentionSec;
      const runs = [
        { runId: "old-completed", startedAt: cutoff - 400, completedAt: cutoff - 390, status: "completed" },
        { runId: "old-failed", startedAt: cutoff - 380, completedAt: cutoff - 370, status: "failed" },
        { runId: "old-running", startedAt: cutoff - 360, completedAt: null, status: "running" },
        { runId: "current-completed", startedAt: cutoff - 700, completedAt: cutoff - 690, status: "completed" },
        { runId: "latest-completed", startedAt: cutoff - 40, completedAt: cutoff - 30, status: "completed" },
      ];
      for (const run of runs) {
        insertRun.run(run.runId, run.startedAt, run.completedAt, run.status, run.completedAt, run.completedAt);
        insertRunRow.run(run.runId, `${run.runId}-coin`, run.completedAt ?? run.startedAt);
      }

      const result = await pruneRedemptionBackstopRunRetention(createSqliteD1(sqlite), {
        nowSec,
        retentionSec,
        preserveRunId: "current-completed",
        batchSize: 2,
      });

      expect(result).toEqual({
        cutoff,
        runRowsDeletedCount: 3,
        runsDeletedCount: 3,
        warnings: [],
      });
      const remainingRuns = sqlite
        .prepare("SELECT run_id FROM redemption_backstop_runs ORDER BY run_id ASC")
        .all()
        .map((row) => (row as { run_id: string }).run_id);
      expect(remainingRuns).toEqual(["current-completed", "latest-completed"]);
      const remainingRunRows = sqlite
        .prepare("SELECT snapshot_run_id FROM redemption_backstop_run_rows ORDER BY snapshot_run_id ASC")
        .all()
        .map((row) => (row as { snapshot_run_id: string }).snapshot_run_id);
      expect(remainingRunRows).toEqual(["current-completed", "latest-completed"]);
    } finally {
      sqlite.close();
    }
  });

  it("records retention failures as completed-run warnings without failing the snapshot", async () => {
    const db = mockD1([
      {
        match: "COUNT(*) AS row_count",
        rows: [],
        first: { row_count: 1, min_updated_at: 1_700_000_000, max_updated_at: 1_700_000_000 },
      },
      {
        match: "DELETE FROM redemption_backstop_runs",
        rows: [],
        runMeta: { changes: 0 },
      },
      {
        match: "DELETE FROM redemption_backstop_run_rows",
        rows: [],
        throwError: new Error("retention unavailable"),
      },
    ]);

    const result = await upsertRedemptionBackstopSnapshots(db, [makeWriteRecord()], {
      runId: "run-retention-warning",
      expectedCount: 1,
      retentionSec: 1_000,
      nowSec: 10_000,
    });

    expect(result).toMatchObject({
      runId: "run-retention-warning",
      runRowsWrittenCount: 1,
      currentMirroredCount: 1,
      retentionCutoff: 9_000,
      retentionRunRowsDeletedCount: 0,
      retentionRunsDeletedCount: 0,
    });
    expect(result.warnings).toEqual([expect.stringContaining("Run-row retention prune failed")]);

    const history = db.getHistory();
    expect(history.some((entry) => entry.sql.includes("status = 'completed'"))).toBe(true);
    expect(history.some((entry) => entry.sql.includes("status = 'failed'"))).toBe(false);
    const metadataUpdates = history.filter((entry) => entry.sql.includes("SET metadata_json = ?"));
    const finalMetadataUpdate = metadataUpdates[metadataUpdates.length - 1];
    const finalMetadata = JSON.parse(String(finalMetadataUpdate?.binds[0] ?? "{}")) as Record<string, unknown>;
    expect(finalMetadata).toMatchObject({
      snapshotRunId: "run-retention-warning",
      writeStatus: "completed-with-warnings",
      writePhase: "retention",
      retentionCutoff: 9_000,
      retentionRunRowsDeletedCount: 0,
      retentionRunsDeletedCount: 0,
      writeWarnings: [expect.stringContaining("retention unavailable")],
    });
  });

  it("preserves manifest deletion counts when orphan run-row retention later fails", async () => {
    const db = mockD1([
      {
        match: "DELETE FROM redemption_backstop_runs",
        rows: [],
        runMeta: { changes: 1 },
      },
      {
        match: "DELETE FROM redemption_backstop_run_rows",
        rows: [],
        throwError: new Error("row prune failed"),
      },
    ]);

    const result = await pruneRedemptionBackstopRunRetention(db, {
      nowSec: 10_000,
      retentionSec: 1_000,
      preserveRunId: "current-run",
      batchSize: 2,
    });

    expect(result).toEqual({
      cutoff: 9_000,
      runRowsDeletedCount: 0,
      runsDeletedCount: 1,
      warnings: [expect.stringContaining("row prune failed")],
    });
    const history = db.getHistory().filter((entry) => entry.sql.includes("DELETE FROM redemption_backstop"));
    expect(history[0]?.sql).toContain("DELETE FROM redemption_backstop_runs");
    expect(history[1]?.sql).toContain("DELETE FROM redemption_backstop_run_rows");
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
