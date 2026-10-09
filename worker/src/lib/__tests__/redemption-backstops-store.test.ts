import { describe, expect, it, vi } from "vitest";
import type { RedemptionBackstopEntry, RedemptionBackstopMap } from "@shared/types/redemption";
import { REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH } from "@shared/lib/methodology-versions/constants";
import { getMethodologyVersionAt } from "@shared/lib/methodology-versions/registry";
import { toMethodologyVersionLabel } from "@shared/lib/methodology-versions/base";
import { assertAllD1MatchesUsed, mockD1Strict } from "@shared/test-utils/mock-d1";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import {
  buildRedemptionBackstopsSnapshot,
  loadRedemptionBackstopLiveSignalRows,
  loadRedemptionBackstopSnapshot,
  normalizeRedemptionBackstopRunMetadata,
  RedemptionBackstopSnapshotUnavailableError,
  resolveSnapshotMethodologyVersion,
  upsertRedemptionBackstopSnapshots,
} from "../redemption-backstops-store";
import { pruneRedemptionBackstopRunRetention } from "../redemption-backstops-store-write";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import {
  completedRunRow,
  completedRunsQuery,
  makeRealisticRedemptionRow,
  makeRedemptionWriteRecord,
  mockRedemptionD1,
  runRowsQuery,
} from "./redemption-backstops-store.test-support";
import { assessReserveFetchFreshness } from "../live-reserves/store-snapshot-state";

const LEGACY_V3997_REDEMPTION_BACKSTOP_ROW = makeRealisticRedemptionRow({
  stablecoin_id: "usdc-circle",
  methodology_version: "3.997",
  snapshot_run_id: "legacy-run",
  updated_at: 1_746_800_000,
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

function findWriteMetadata(
  history: Array<{ binds: unknown[] }>,
  runId: string,
  writeStatus: string,
): Record<string, unknown> {
  for (const { binds } of history) {
    for (const bind of binds) {
      if (typeof bind !== "string" || !bind.startsWith("{")) continue;
      try {
        const metadata = JSON.parse(bind) as Record<string, unknown>;
        if (metadata.snapshotRunId === runId && metadata.writeStatus === writeStatus) return metadata;
      } catch { continue; }
    }
  }
  throw new Error(`Missing ${writeStatus} metadata for ${runId}`);
}

describe("loadRedemptionBackstopSnapshot", () => {
  it("round-trips immutable bindings and rejects legacy admission without inferred inputs", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      const db = createSqliteD1(sqlite);
      const record = makeRedemptionWriteRecord();
      const reserveInput = { generationId: "reserve:1700000000:test", contentSha256: "a".repeat(64), stablecoinId: record.stablecoinId, attemptId: null, configFingerprint: "b".repeat(64),
        freshness: assessReserveFetchFreshness({ fetchedAt: record.updatedAt - 60, attemptId: null, metadata: { freshnessMode: "not-applicable" } }, record.updatedAt, 172800) };
      record.reserveInput = reserveInput;
      await upsertRedemptionBackstopSnapshots(db, [record], { runId: "redemption:binding", nowSec: record.updatedAt, metadata: {
        reserveViewSchemaVersion: 2, reserveGenerationId: reserveInput.generationId, reserveContentSha256: reserveInput.contentSha256, runClockSec: record.updatedAt,
        consumedReserveInputs: { [record.stablecoinId]: reserveInput },
        stablecoinsInput: { updatedAt: record.updatedAt - 120, assessedAt: record.updatedAt, maxAgeSec: 600 },
      } });
      const loaded = await loadRedemptionBackstopSnapshot(db);
      expect(loaded.map[record.stablecoinId].reserveInput).toEqual(reserveInput);
      expect(loaded.latestUpdatedAt).toBe(record.updatedAt);
      expect(loaded.runMetadata?.stablecoinsInput).toEqual({ updatedAt: record.updatedAt - 120, assessedAt: record.updatedAt, maxAgeSec: 600 });
      sqlite.exec("UPDATE redemption_backstop_runs SET metadata_json = '{}'");
      expect((await loadRedemptionBackstopSnapshot(db)).reserveInputAssessment?.state).toBe("unavailable");
    } finally { sqlite.close(); }
  });

  it("surfaces a missing mandatory run-manifest table", async () => {
    const db = mockD1Strict([
      {
        ...completedRunsQuery([]),
        throwError: new Error("D1_ERROR: no such table: redemption_backstop_runs"),
      },
    ]);

    await expect(loadRedemptionBackstopSnapshot(db)).rejects.toMatchObject({
      message: "Failed to load redemption backstop snapshot",
      cause: expect.objectContaining({ message: "D1_ERROR: no such table: redemption_backstop_runs" }),
    });
    assertAllD1MatchesUsed(db);
  });

  it.each([undefined, []] as const)("projects the same unknown failed-row loss for absent or empty outcomes (%j)", async (lossOutcomes) => {
    const row = makeRealisticRedemptionRow({ snapshot_run_id: "run-failed", score: null });
    row.details_json = JSON.stringify({
      ...JSON.parse(row.details_json),
      resolutionState: "failed",
      ...(lossOutcomes === undefined ? {} : { lossOutcomes }),
    });
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow({ run_id: "run-failed" })]),
      runRowsQuery("run-failed", [row]),
    ]);
    const loaded = await loadRedemptionBackstopSnapshot(db);
    const losses = loaded.lossOutcomesByAssetId?.["eurc-circle"];
    expect(losses).toEqual([expect.objectContaining({
      scope: { assetId: "eurc-circle", kind: "route", key: "redemption:eurc-circle:offchain-issuer" },
      disposition: "unknown", reason: "sync-error", legacy: true,
      attemptId: null, runId: null, generationId: null, observedAtSec: row.updated_at,
      proof: null, priorEvidence: null,
    })]);
    expect(loaded.map["eurc-circle"].lossOutcomes).toEqual(losses);
    assertAllD1MatchesUsed(db);
  });

  it("prefers the latest completed run when loading a snapshot", async () => {
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow({ run_id: "run-new", methodology_version: "1.1" })]),
      runRowsQuery("run-new", [makeRealisticRedemptionRow({ snapshot_run_id: "run-new", methodology_version: "1.1" })]),
    ]);

    const result = await loadRedemptionBackstopSnapshot(db);

    expect(result.runId).toBe("run-new");
    expect(result.latestUpdatedAt).toBe(1_700_000_000);
    expect(result.methodologyVersion).toBe("1.1");
    expect(result.snapshotSource).toBe("run-rows");
    expect(Object.keys(result.map)).toEqual(["eurc-circle"]);
    assertAllD1MatchesUsed(db);
  });

  it("quarantines attributable malformed rows from the newest run without serving older evidence", async () => {
    const db = mockD1Strict([
      completedRunsQuery([
        completedRunRow({ run_id: "run-corrupt" }),
        completedRunRow({ run_id: "run-valid", completed_at: 1_700_000_000, min_updated_at: 1_699_999_990, max_updated_at: 1_699_999_990 }),
      ]),
      runRowsQuery("run-corrupt", [makeRealisticRedemptionRow({ snapshot_run_id: "run-corrupt", score: 101 })]),
    ]);
    const result = await loadRedemptionBackstopSnapshot(db);
    expect(result.runId).toBe("run-corrupt");
    expect(result.map).toEqual({});
    expect(result.quarantinedAssetIds).toEqual(["eurc-circle"]);
    expect(result.lossOutcomesByAssetId?.["eurc-circle"]).toMatchObject([{ disposition: "semantic", reason: "malformed-persisted-row" }]);
    expect(result.latestUpdatedAt).toBe(1_700_000_000);
    assertAllD1MatchesUsed(db);
  });

  it("rejects a completed manifest when its immutable run rows are missing", async () => {
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow({ run_id: "run-mirror", methodology_version: "1.1" })]),
      runRowsQuery("run-mirror", []),
    ]);

    await expect(loadRedemptionBackstopSnapshot(db)).rejects.toThrow(
      "Untrusted newest redemption run census",
    );
    assertAllD1MatchesUsed(db);
  });

  it("fails globally for an incomplete newest manifest without hiding behind an earlier run", async () => {
    const db = mockD1Strict([
      completedRunsQuery([
        completedRunRow({ run_id: "run-incomplete", expected_count: 2 }),
        completedRunRow({ run_id: "run-valid" }),
      ]),
    ]);
    await expect(loadRedemptionBackstopSnapshot(db)).rejects.toThrow("Untrusted newest redemption run manifest");
    assertAllD1MatchesUsed(db);
  });


  it("fails globally when the newest completed manifest has no output clock", async () => {
    const db = mockD1Strict([
      completedRunsQuery([
        completedRunRow({ run_id: "run-missing-max", max_updated_at: null }),
        completedRunRow({ run_id: "run-valid" }),
      ]),
    ]);
    await expect(loadRedemptionBackstopSnapshot(db)).rejects.toThrow("Untrusted newest redemption run manifest");
    assertAllD1MatchesUsed(db);
  });

  it("serves immutable rows from the latest completed run when the current mirror was overwritten by a failed run", async () => {
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow({ run_id: "run-old-completed", completed_at: 1_700_000_000, min_updated_at: 1_699_999_990, max_updated_at: 1_699_999_990 })]),
      runRowsQuery("run-old-completed", [makeRealisticRedemptionRow({ snapshot_run_id: "run-old-completed", updated_at: 1_699_999_990 })]),
    ]);

    const result = await loadRedemptionBackstopSnapshot(db);

    expect(result.runId).toBe("run-old-completed");
    expect(result.latestUpdatedAt).toBe(1_699_999_990);
    expect(result.map["eurc-circle"]?.updatedAt).toBe(1_699_999_990);
    assertAllD1MatchesUsed(db);
  });


  it("fails globally when route identity cannot be trusted", async () => {
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow({ run_id: "run-bad" }), completedRunRow({ run_id: "run-valid" })]),
      runRowsQuery("run-bad", [makeRealisticRedemptionRow({ snapshot_run_id: "run-bad", route_family: "bad-family" })]),
    ]);
    await expect(loadRedemptionBackstopSnapshot(db)).rejects.toThrow("Untrusted redemption row identity or clock");
    assertAllD1MatchesUsed(db);
  });

  it("fails closed without reading current rows when no completed run exists", async () => {
    const db = mockD1Strict([
      completedRunsQuery([]),
    ]);

    await expect(loadRedemptionBackstopSnapshot(db)).rejects.toThrow(
      "No completed redemption backstop run found",
    );
    assertAllD1MatchesUsed(db);
  });

  it("uses the completed run manifest methodology version for snapshot attribution", async () => {
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow({ run_id: "run-v404", methodology_version: "4.04" })]),
      runRowsQuery("run-v404", [makeRealisticRedemptionRow({ snapshot_run_id: "run-v404", methodology_version: "4.04" })]),
    ]);

    const result = await buildRedemptionBackstopsSnapshot(db);

    expect(result.methodology.version).toBe("4.04");
    expect(result.methodology.versionLabel).toBe("v4.04");
    expect(result.methodology.changelogPath).toBe(REDEMPTION_BACKSTOP_METHODOLOGY_CHANGELOG_PATH);
    expect(result.snapshotSource).toBe("run-rows");
    expect(result.coins["eurc-circle"]?.methodologyVersion).toBe("4.04");
    assertAllD1MatchesUsed(db);
  });

  it("salvages invalid historical diagnostics without dropping valid evidence or provenance", async () => {
    const original = JSON.parse(LEGACY_V3997_REDEMPTION_BACKSTOP_ROW.details_json);
    const db = mockD1Strict([
      completedRunsQuery([LEGACY_V3997_REDEMPTION_BACKSTOP_RUN_ROW]),
      runRowsQuery("legacy-run", [{
        ...LEGACY_V3997_REDEMPTION_BACKSTOP_ROW,
        details_json: JSON.stringify({
          ...original,
          sourceTimestamp: 1_746_799_900,
          sourceUrls: ["https://example.com/redemption.json"],
          notes: ["valid", 123],
          capsApplied: ["valid-cap", false],
          docs: { url: "not-a-url" },
          confidenceDetails: { capacityEvidenceQuality: 101 },
          costScenarioScores: { retail: "free" },
        }),
      }]),
    ]);

    const { map } = await loadRedemptionBackstopSnapshot(db);
    expect(map["usdc-circle"]).toMatchObject({
      score: LEGACY_V3997_REDEMPTION_BACKSTOP_ROW.score,
      resolutionState: original.resolutionState,
      capacityConfidence: original.capacityConfidence,
      routeStatus: original.routeStatus,
      sourceTimestamp: 1_746_799_900,
      sourceUrls: ["https://example.com/redemption.json"],
    });
    expect(map["usdc-circle"].notes).toBeUndefined();
    expect(map["usdc-circle"].capsApplied).toBeUndefined();
    expect(map["usdc-circle"].docs).toBeUndefined();
    expect(map["usdc-circle"].confidenceDetails).toBeUndefined();
    expect(map["usdc-circle"].costScenarioScores).toBeUndefined();
    assertAllD1MatchesUsed(db);
  });

  it.each([
    null, "", "not-json", '{"resolutionState":', "null", "[]", '[{"resolutionState":"resolved"}]',
    '"resolved"', "0", "true", "{}",
  ])("rejects positive-score rows with missing or corrupt whole details: %s", async (detailsJson) => {
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow()]),
      runRowsQuery("run-live", [makeRealisticRedemptionRow({ score: 65, details_json: detailsJson })]),
    ]);
    const loaded = await loadRedemptionBackstopSnapshot(db);
    expect(loaded.quarantinedAssetIds).toEqual(["eurc-circle"]);
    expect(loaded.map).not.toHaveProperty("eurc-circle");
    assertAllD1MatchesUsed(db);
  });

  it.each([
    { detailsJson: null, version: "4.07", reason: "missing-details" },
    { detailsJson: "not-json", version: "4.07", reason: "json-parse-failed" },
    { detailsJson: "null", version: "4.07", reason: "invalid-payload" },
    { detailsJson: '{"resolutionState":"resolved"}', version: "4.07", reason: "invalid-payload" },
    { detailsJson: '{"resolutionState":"resolved"}', version: "v3.997", reason: "unrecognized-methodology-version" },
  ])("reports decoder drop $reason in the structured log and rejected-run diagnostics", async ({ detailsJson, version, reason }) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const db = mockD1Strict([
        completedRunsQuery([completedRunRow({ methodology_version: version })]),
        runRowsQuery("run-live", [makeRealisticRedemptionRow({
          methodology_version: version, details_json: detailsJson,
        })]),
      ]);
      const loaded = await loadRedemptionBackstopSnapshot(db);
      expect(loaded.quarantinedAssetIds).toEqual(["eurc-circle"]);
      expect(loaded.lossOutcomesByAssetId?.["eurc-circle"]?.[0].reason).toBe("malformed-persisted-row");
      expect(loaded.map).not.toHaveProperty("eurc-circle");
      const records = warning.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(records).toContainEqual(expect.objectContaining({
        event: "redemption-backstop-row-rejected",
        runId: "run-live",
        metadata: expect.objectContaining({ stablecoinId: "eurc-circle", methodologyVersion: version, reason }),
      }));
      assertAllD1MatchesUsed(db);
    } finally {
      warning.mockRestore();
    }
  });

  it("continues admitting complete current details under an unrecognized methodology version", async () => {
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow({ methodology_version: "v4.07" })]),
      runRowsQuery("run-live", [makeRealisticRedemptionRow({ methodology_version: "v4.07" })]),
    ]);
    const { map } = await loadRedemptionBackstopSnapshot(db);
    expect(map["eurc-circle"].methodologyVersion).toBe("v4.07");
    assertAllD1MatchesUsed(db);
  });

  it.each([
    "resolutionState", "capacityConfidence", "capacitySemantics", "feeConfidence", "feeModelKind",
    "modelConfidence", "routeStatus", "routeStatusSource", "holderEligibility",
  ])("rejects current immutable rows missing required %s", async (field) => {
    const details = JSON.parse(makeRealisticRedemptionRow().details_json);
    delete details[field];
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow()]),
      runRowsQuery("run-live", [makeRealisticRedemptionRow({
        methodology_version: "4.07", details_json: JSON.stringify(details),
      })]),
    ]);
    const loaded = await loadRedemptionBackstopSnapshot(db);
    expect(loaded.quarantinedAssetIds).toEqual(["eurc-circle"]);
    expect(loaded.map).not.toHaveProperty("eurc-circle");
    assertAllD1MatchesUsed(db);
  });

  it.each(["4.07", "3.997"])("rejects corrupt evidence even when diagnostics can be salvaged in %s", async (version) => {
    const details = JSON.parse(makeRealisticRedemptionRow().details_json);
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow({ methodology_version: version })]),
      runRowsQuery("run-live", [makeRealisticRedemptionRow({
        methodology_version: version,
        details_json: JSON.stringify({ ...details, reserveInput: {}, notes: ["note", 123] }),
      })]),
    ]);
    const loaded = await loadRedemptionBackstopSnapshot(db);
    expect(loaded.quarantinedAssetIds).toEqual(["eurc-circle"]);
    expect(loaded.map).not.toHaveProperty("eurc-circle");
    assertAllD1MatchesUsed(db);
  });

  it.each(["resolutionState", "sourceTimestamp", "sourceUrls"])("never salvages corrupt historical %s as missing", async (field) => {
    const details = JSON.parse(LEGACY_V3997_REDEMPTION_BACKSTOP_ROW.details_json);
    const invalid = field === "resolutionState" ? "broken" : field === "sourceTimestamp" ? -1 : ["ftp://example.com"];
    const db = mockD1Strict([
      completedRunsQuery([LEGACY_V3997_REDEMPTION_BACKSTOP_RUN_ROW]),
      runRowsQuery("legacy-run", [{
        ...LEGACY_V3997_REDEMPTION_BACKSTOP_ROW,
        details_json: JSON.stringify({ ...details, [field]: invalid, notes: ["note", 123] }),
      }]),
    ]);
    const loaded = await loadRedemptionBackstopSnapshot(db);
    expect(loaded.quarantinedAssetIds).toEqual(["usdc-circle"]);
    expect(loaded.map).not.toHaveProperty("usdc-circle");
    assertAllD1MatchesUsed(db);
  });

  it.each([
    { resolutionState: "failed", score: 65 },
    { resolutionState: "missing-capacity", score: 0 },
    { resolutionState: "invalid-state", score: null },
  ])("rejects incoherent current score/state $resolutionState/$score", async ({ resolutionState, score }) => {
    const details = JSON.parse(makeRealisticRedemptionRow().details_json);
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow()]),
      runRowsQuery("run-live", [makeRealisticRedemptionRow({
        methodology_version: "4.07", score, details_json: JSON.stringify({ ...details, resolutionState }),
      })]),
    ]);
    const loaded = await loadRedemptionBackstopSnapshot(db);
    expect(loaded.quarantinedAssetIds).toEqual(["eurc-circle"]);
    expect(loaded.map).not.toHaveProperty("eurc-circle");
    assertAllD1MatchesUsed(db);
  });

  it("preserves a resolved measured zero separately from absent capacity", async () => {
    const details = JSON.parse(makeRealisticRedemptionRow().details_json);
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow({ expected_count: 2, written_count: 2 })]),
      runRowsQuery("run-live", [
        makeRealisticRedemptionRow({
          stablecoin_id: "measured-zero", methodology_version: "4.07", score: 0,
          immediate_capacity_usd: 0, immediate_capacity_ratio: 0, details_json: JSON.stringify(details),
        }),
        makeRealisticRedemptionRow({
          stablecoin_id: "absent", methodology_version: "4.07", score: null,
          immediate_capacity_usd: null, immediate_capacity_ratio: null,
          details_json: JSON.stringify({ ...details, resolutionState: "missing-capacity" }),
        }),
      ]),
    ]);
    const { map } = await loadRedemptionBackstopSnapshot(db);
    expect(map["measured-zero"]).toMatchObject({ score: 0, immediateCapacityUsd: 0, resolutionState: "resolved" });
    expect(map.absent).toMatchObject({ score: null, immediateCapacityUsd: null, resolutionState: "missing-capacity" });
    assertAllD1MatchesUsed(db);
  });

  it("keeps a peer's newest adverse zero while quarantining only the bad row", async () => {
    const db = mockD1Strict([
      completedRunsQuery([
        completedRunRow({ run_id: "run-new", expected_count: 2, written_count: 2 }),
        completedRunRow({ run_id: "run-old" }),
      ]),
      runRowsQuery("run-new", [
        makeRealisticRedemptionRow({ snapshot_run_id: "run-new", stablecoin_id: "bad", details_json: "not-json" }),
        makeRealisticRedemptionRow({ snapshot_run_id: "run-new", stablecoin_id: "peer", score: 0, immediate_capacity_usd: 0, immediate_capacity_ratio: 0 }),
      ]),
    ]);
    const result = await loadRedemptionBackstopSnapshot(db);
    expect(result.runId).toBe("run-new");
    expect(Object.keys(result.map)).toEqual(["peer"]);
    expect(result.map.peer).toMatchObject({ score: 0, immediateCapacityUsd: 0, updatedAt: 1_700_000_000 });
    expect(result.quarantinedAssetIds).toEqual(["bad"]);
    expect(result.lossOutcomesByAssetId?.bad[0]).toMatchObject({ disposition: "semantic", reason: "malformed-persisted-row", runId: "run-new" });
    assertAllD1MatchesUsed(db);
  });

  it("decodes legacy v3.997 immutable-run rows without v4 optional fields", async () => {
    const db = mockD1Strict([
      completedRunsQuery([LEGACY_V3997_REDEMPTION_BACKSTOP_RUN_ROW]),
      runRowsQuery("legacy-run", [LEGACY_V3997_REDEMPTION_BACKSTOP_ROW]),
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
    assertAllD1MatchesUsed(db);
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

  it.each([
    { updatedAt: 0, assessedAt: 1_800_000_000, maxAgeSec: 600 },
    { updatedAt: 1_800_000_001, assessedAt: 1_800_000_000, maxAgeSec: 600 },
    { updatedAt: 1_799_999_399, assessedAt: 1_800_000_000, maxAgeSec: 600 },
    { assessedAt: 1_800_000_000, maxAgeSec: 600 },
  ])("does not normalize malformed supply identity as admitted evidence (%j)", (stablecoinsInput) => {
    expect(normalizeRedemptionBackstopRunMetadata(JSON.stringify({ stablecoinsInput }))).not.toHaveProperty("stablecoinsInput");
  });

  it("rejects invalid supply metadata before creating a manifest", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      await expect(upsertRedemptionBackstopSnapshots(createSqliteD1(sqlite), [makeRedemptionWriteRecord()], {
        metadata: { stablecoinsInput: { updatedAt: 0, assessedAt: 1_800_000_000, maxAgeSec: 600 } },
      })).rejects.toThrow();
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM redemption_backstop_runs").get()).toEqual({ count: 0 });
    } finally { sqlite.close(); }
  });

  it("writes immutable run/history rows under a completed run manifest without a legacy current mirror", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      const result = await upsertRedemptionBackstopSnapshots(
        createSqliteD1(sqlite),
        [makeRedemptionWriteRecord({ stablecoinId: "eurc-circle" })],
        { runId: "run-test", expectedCount: 1, metadata: { configured: 1 } },
      );
      expect(result).toMatchObject({
        runId: "run-test", attemptedCount: 1, runRowsWrittenCount: 1,
        historyWrittenCount: 1, warnings: [],
      });
      expect(result).not.toHaveProperty("currentMirroredCount");
      const manifest = sqlite
        .prepare("SELECT status, written_count, metadata_json FROM redemption_backstop_runs WHERE run_id = ?")
        .get("run-test") as { status: string; written_count: number; metadata_json: string };
      expect(manifest.status).toBe("completed");
      expect(manifest.written_count).toBe(1);
      expect(sqlite.prepare(
        "SELECT snapshot_run_id, stablecoin_id FROM redemption_backstop_run_rows WHERE snapshot_run_id = ?",
      ).get("run-test")).toEqual({ snapshot_run_id: "run-test", stablecoin_id: "eurc-circle" });
      expect(sqlite.prepare(
        "SELECT snapshot_run_id, stablecoin_id FROM redemption_backstop_history WHERE snapshot_run_id = ?",
      ).get("run-test")).toEqual({ snapshot_run_id: "run-test", stablecoin_id: "eurc-circle" });
      const legacyCurrentCount = sqlite.prepare(
        "SELECT COUNT(*) AS count FROM redemption_backstop",
      ).get() as { count: number };
      expect(legacyCurrentCount.count).toBe(0);
      const finalMetadata = JSON.parse(manifest.metadata_json) as Record<string, unknown>;
      expect(finalMetadata).toMatchObject({
        configured: 1, snapshotRunId: "run-test", attemptedCount: 1,
        runRowsWrittenCount: 1, historyWrittenCount: 1, writeStatus: "completed",
      });
      expect(finalMetadata).not.toHaveProperty("currentMirroredCount");
    } finally {
      sqlite.close();
    }
  });

  it("marks a started run as failed when row writes fail", async () => {
    const db = mockRedemptionD1([
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
    const record = makeRedemptionWriteRecord({ stablecoinId: "eurc-circle" });

    await expect(
      upsertRedemptionBackstopSnapshots(db, [record], {
        runId: "run-fails",
        expectedCount: 1,
      }),
    ).rejects.toThrow("history write failed");

    const failedMetadata = findWriteMetadata(db.getHistory(), "run-fails", "failed");
    expect(failedMetadata).toMatchObject({
      snapshotRunId: "run-fails",
      attemptedCount: 1,
      runRowsWrittenCount: 1,
      historyWrittenCount: 0,
      writeStatus: "failed",
      writePhase: "history",
    });
  });

  it("marks a started run as failed when immutable run rows are incomplete", async () => {
    const db = mockRedemptionD1([
      {
        match: "COUNT(*) AS row_count",
        rows: [],
        first: { row_count: 1, min_updated_at: 1_700_000_000, max_updated_at: 1_700_000_000 },
      },
    ]);
    const records = [
      makeRedemptionWriteRecord({ stablecoinId: "eurc-circle" }),
      makeRedemptionWriteRecord({ stablecoinId: "usdc-circle" }),
    ];

    await expect(
      upsertRedemptionBackstopSnapshots(db, records, {
        runId: "run-partial",
        expectedCount: 2,
      }),
    ).rejects.toThrow("wrote 1/2 immutable rows");

    const failedMetadata = findWriteMetadata(db.getHistory(), "run-partial", "failed");
    expect(failedMetadata).toMatchObject({
      snapshotRunId: "run-partial",
      attemptedCount: 2,
      writeStatus: "failed",
      writePhase: "run-rows",
    });
  });

  it("prunes old run rows and manifests while preserving the current and latest completed runs", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      const insertRun = sqlite.prepare(
        `INSERT INTO redemption_backstop_runs (
          run_id, started_at, completed_at, status, expected_count, written_count,
          methodology_version, min_updated_at, max_updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, 1, 1, '4.04', ?, ?, NULL)`,
      );
      const insertRunRow = sqlite.prepare(
        `INSERT INTO redemption_backstop_run_rows (
          snapshot_run_id, stablecoin_id, route_family, access_model, settlement_model,
          execution_model, output_asset_type, provider, source_mode, methodology_version, updated_at
        ) VALUES (?, ?, 'issuer-direct', 'permissioned', 't-plus-n', 'discretionary',
                  'fiat', 'issuer', 'curated', '4.04', ?)`,
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
      const historyRetentionSec = 2_000;
      const historyCutoff = nowSec - historyRetentionSec;
      const insertHistory = sqlite.prepare(
        `INSERT INTO redemption_backstop_history
          (stablecoin_id, snapshot_date, updated_at, methodology_version)
         VALUES (?, ?, ?, '4.04')`,
      );
      insertHistory.run("usdt-tether", historyCutoff - 100, historyCutoff - 100);
      insertHistory.run("usdc-circle", historyCutoff - 50, historyCutoff - 50);
      insertHistory.run("usdt-tether", historyCutoff + 500, historyCutoff + 500);

      const result = await pruneRedemptionBackstopRunRetention(createSqliteD1(sqlite), {
        nowSec, retentionSec, historyRetentionSec,
        preserveRunId: "current-completed", batchSize: 2,
      });
      expect(result).toEqual({
        cutoff, runRowsDeletedCount: 3, runsDeletedCount: 3, historyCutoff,
        historyRowsDeletedCount: 2, truncated: false, warnings: [],
      });
      const remainingHistory = sqlite.prepare(
        "SELECT stablecoin_id, snapshot_date FROM redemption_backstop_history",
      ).all() as Array<{ stablecoin_id: string; snapshot_date: number }>;
      expect(remainingHistory).toEqual([
        { stablecoin_id: "usdt-tether", snapshot_date: historyCutoff + 500 },
      ]);
      const remainingRunRecords = sqlite.prepare(
        "SELECT run_id FROM redemption_backstop_runs ORDER BY run_id ASC").all() as Array<{ run_id: string }>;
      const remainingRuns = remainingRunRecords.map((row) => row.run_id);
      expect(remainingRuns).toEqual(["current-completed", "latest-completed"]);
      const remainingRunRowRecords = sqlite.prepare(
        "SELECT snapshot_run_id FROM redemption_backstop_run_rows ORDER BY snapshot_run_id ASC").all() as Array<{ snapshot_run_id: string }>;
      const remainingRunRows = remainingRunRowRecords.map((row) => row.snapshot_run_id);
      expect(remainingRunRows).toEqual(["current-completed", "latest-completed"]);
    } finally {
      sqlite.close();
    }
  });

  it("records retention failures as completed-run warnings without failing the snapshot", async () => {
    const db = mockRedemptionD1([
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

    const result = await upsertRedemptionBackstopSnapshots(db, [makeRedemptionWriteRecord()], {
      runId: "run-retention-warning",
      expectedCount: 1,
      retentionSec: 1_000,
      nowSec: 10_000,
    });

    expect(result).toMatchObject({
      runId: "run-retention-warning",
      runRowsWrittenCount: 1,
      retentionCutoff: 9_000,
      retentionRunRowsDeletedCount: 0,
      retentionRunsDeletedCount: 0,
    });
    expect(result.warnings).toEqual([expect.stringContaining("Run-row retention prune failed")]);

    const finalMetadata = findWriteMetadata(
      db.getHistory(),
      "run-retention-warning",
      "completed-with-warnings",
    );
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
    const db = mockRedemptionD1([
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
      {
        match: "DELETE FROM redemption_backstop_history",
        rows: [],
        runMeta: { changes: 0 },
      },
    ]);

    const result = await pruneRedemptionBackstopRunRetention(db, {
      nowSec: 10_000,
      retentionSec: 1_000,
      historyRetentionSec: 1_000,
      preserveRunId: "current-run",
      batchSize: 2,
    });

    expect(result).toEqual({
      cutoff: 9_000,
      runRowsDeletedCount: 0,
      runsDeletedCount: 1,
      historyCutoff: 9_000,
      historyRowsDeletedCount: 0,
      truncated: false,
      warnings: [expect.stringContaining("row prune failed")],
    });
  });

  it("caps a large retention backlog and reports truncation", async () => {
    const sqlite = createLatestSchemaSqlite().sqlite;
    try {
      const insertRun = sqlite.prepare(
        `INSERT INTO redemption_backstop_runs (
          run_id, started_at, completed_at, status, expected_count, written_count,
          methodology_version, min_updated_at, max_updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, 0, 0, '4.04', NULL, NULL, NULL)`,
      );
      for (let index = 0; index < 7; index += 1) {
        insertRun.run(`old-${index}`, 8_000 + index, 8_000 + index, "failed");
      }
      insertRun.run("latest-completed", 8_100, 8_100, "completed");

      const result = await pruneRedemptionBackstopRunRetention(createSqliteD1(sqlite), {
        nowSec: 10_000, retentionSec: 1_000, preserveRunId: "current-run",
        batchSize: 2, maxBatches: 3,
      });
      expect(result).toMatchObject({
        runsDeletedCount: 6, runRowsDeletedCount: 0, historyRowsDeletedCount: 0,
        truncated: true, warnings: [expect.stringContaining("truncated")],
      });
      const remainingRunRecords = sqlite.prepare(
        "SELECT run_id FROM redemption_backstop_runs ORDER BY run_id ASC").all() as Array<{ run_id: string }>;
      const remainingRuns = remainingRunRecords.map((row) => row.run_id);
      expect(remainingRuns).toEqual(["latest-completed", "old-6"]);
    } finally {
      sqlite.close();
    }
  });
});

describe("loadRedemptionBackstopLiveSignalRows", () => {
  const LIVE_SIGNAL_ROWS_SQL =
    "SELECT stablecoin_id, immediate_capacity_ratio, route_family, updated_at FROM redemption_backstop_run_rows WHERE snapshot_run_id = ?";

  it("serves narrow live-signal rows from the latest valid completed run", async () => {
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow()]),
      {
        match: LIVE_SIGNAL_ROWS_SQL,
        matchBinds: ["run-live"],
        rows: [
          {
            stablecoin_id: "eurc-circle",
            immediate_capacity_ratio: 0.42,
            route_family: "offchain-issuer",
            updated_at: 1_700_000_000,
          },
        ],
      },
    ]);

    const rows = await loadRedemptionBackstopLiveSignalRows(db, ["eurc-circle"]);

    expect(rows).toEqual([
      {
        stablecoin_id: "eurc-circle",
        immediate_capacity_ratio: 0.42,
        route_family: "offchain-issuer",
        updated_at: 1_700_000_000,
      },
    ]);
    assertAllD1MatchesUsed(db);
  });

  it("fails globally for an untrusted newest live-signal manifest", async () => {
    const db = mockD1Strict([completedRunsQuery([
      completedRunRow({ run_id: "run-incomplete", expected_count: 2 }),
      completedRunRow({ run_id: "run-valid" }),
    ])]);
    await expect(loadRedemptionBackstopLiveSignalRows(db, ["eurc-circle"])).rejects.toThrow("Untrusted newest redemption live-signal manifest");
    assertAllD1MatchesUsed(db);
  });

  it("fails globally for a missing live-signal census row instead of serving older evidence", async () => {
    const db = mockD1Strict([
      completedRunsQuery([
        completedRunRow({ run_id: "run-partial", expected_count: 2, written_count: 2 }),
        completedRunRow({ run_id: "run-valid" }),
      ]),
      { match: LIVE_SIGNAL_ROWS_SQL, matchBinds: ["run-partial"], rows: [
        { stablecoin_id: "eurc-circle", immediate_capacity_ratio: 0.1, route_family: "offchain-issuer", updated_at: 1_700_000_000 },
      ] },
    ]);
    await expect(loadRedemptionBackstopLiveSignalRows(db, ["eurc-circle"])).rejects.toThrow("Untrusted newest redemption live-signal census");
    assertAllD1MatchesUsed(db);
  });

  it("keeps the newest adverse peer when another live-signal payload is malformed", async () => {
    const db = mockD1Strict([
      completedRunsQuery([completedRunRow({ expected_count: 2, written_count: 2 })]),
      { match: LIVE_SIGNAL_ROWS_SQL, matchBinds: ["run-live"], rows: [
        { stablecoin_id: "eurc-circle", immediate_capacity_ratio: 0, route_family: "offchain-issuer", updated_at: 1_700_000_000 },
        { stablecoin_id: "usdc-circle", immediate_capacity_ratio: 2, route_family: "offchain-issuer", updated_at: 1_700_000_000 },
      ] },
    ]);
    expect(await loadRedemptionBackstopLiveSignalRows(db, ["eurc-circle", "usdc-circle"])).toEqual([
      { stablecoin_id: "eurc-circle", immediate_capacity_ratio: 0, route_family: "offchain-issuer", updated_at: 1_700_000_000 },
    ]);
    assertAllD1MatchesUsed(db);
  });

  it("fails closed with the typed error when no completed run exists", async () => {
    const db = mockD1Strict([completedRunsQuery([])]);

    await expect(loadRedemptionBackstopLiveSignalRows(db, ["eurc-circle"])).rejects.toBeInstanceOf(
      RedemptionBackstopSnapshotUnavailableError,
    );
    assertAllD1MatchesUsed(db);
  });

  it("returns no rows without querying when no coins are requested", async () => {
    const db = mockD1Strict([]);

    await expect(loadRedemptionBackstopLiveSignalRows(db, [])).resolves.toEqual([]);
    expect(db.getHistory()).toEqual([]);
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
    expect(result.versionLabel).toBe(toMethodologyVersionLabel("3.97"));
  });

  it("falls back to the keyed methodology resolver when no entry matches the updatedAt", () => {
    const coins: RedemptionBackstopMap = {
      "a-coin": makeMapEntry(1_700_000_000, "1.1"),
    };
    const queryAt = 1_500_000_000;
    const expectedVersion = getMethodologyVersionAt("redemption-backstop", queryAt);

    const result = resolveSnapshotMethodologyVersion(coins, queryAt);

    expect(result.version).toBe(expectedVersion);
    expect(result.versionLabel).toBe(toMethodologyVersionLabel(expectedVersion));
  });

  it("falls back to the keyed methodology resolver when updatedAt is zero", () => {
    const coins: RedemptionBackstopMap = {
      "a-coin": makeMapEntry(1_700_000_000, "1.1"),
    };
    const expectedVersion = getMethodologyVersionAt("redemption-backstop", 0);

    const result = resolveSnapshotMethodologyVersion(coins, 0);

    expect(result.version).toBe(expectedVersion);
    expect(result.versionLabel).toBe(toMethodologyVersionLabel(expectedVersion));
  });
});
