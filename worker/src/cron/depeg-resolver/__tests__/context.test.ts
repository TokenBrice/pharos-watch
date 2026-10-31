import { afterEach, describe, expect, it, vi } from "vitest";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { computeDuration, groupIncidents, structuralClass, type DdrStratumKey } from "@shared/lib/depeg-resolver";
import { DDR_INELIGIBLE_AUDIT_VERDICTS } from "@shared/types/depeg-audit";
import { loadDdrContext, loadDdrHistoricalEvents } from "../context";
import { HISTORICAL_ROW_CAP, TRAINING_WINDOW_SEC } from "../constants";
import { activeRow, NOW_SEC } from "./depeg-resolver.test-support";
import { seedAssessmentSample, seedHistoricalEvent, seedResolverInputs } from "./context.test-support";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import * as activeSafetyScoreSource from "../../../lib/safety-score-active-source";
import { makeWorkerReportCardsV9Response, makeWorkerV9Card } from "../../../test-helpers/report-cards-v9";
import { toStructural } from "../utils";
import { MINT_BURN_CONFIGS } from "../../../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../../../lib/mint-burn-pipeline/sync-state";
import { mintBurnScanCoverageStatements, mintBurnScanFingerprint } from "../../../lib/mint-burn-pipeline/scan-coverage";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});
const startedAt = NOW_SEC - 10 * 86400;
const key: DdrStratumKey = { direction: "below", depth: "catastrophic", structural: "fragile", currency: "USD" };

describe("DDR historical context", () => {
  it("excludes pending and disabled legs from both mint-surge rows and its scan proof", async () => {
    const { sqlite, db } = fixtures.open();
    seedResolverInputs(sqlite);
    const configs = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "usdc-circle");
    const pending = { ...configs[0], chain: { ...configs[0].chain, chainId: "synthetic-pending" } };
    const end = Math.floor(activeRow().started_at / 3600) * 3600;
    MINT_BURN_CONFIGS.push(pending);
    try {
      for (const config of configs) {
        await db.batch(mintBurnScanCoverageStatements(db, {
          configKey: mintBurnConfigKey(config), configFingerprint: mintBurnScanFingerprint(config),
          chainId: config.chain.chainId, fromBlock: 1, toBlock: 2, fromTimestamp: end - 7 * 86400,
          // A fresh frontier keeps the leg out of the post-admission stall gate; this
          // test owns pending/disabled exclusion, not frontier freshness.
          toTimestamp: NOW_SEC, finalizedBlock: 2, acceptedAt: NOW_SEC,
        }));
      }
      const insert = sqlite.prepare(`INSERT INTO mint_burn_hourly (stablecoin_id, chain_id, hour_ts, mint_count, burn_count,
        mint_unpriced_event_count, burn_unpriced_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
        VALUES ('usdc-circle', ?, ?, 1, 0, 0, 0, ?, 0, ?)`);
      insert.run(configs[0].chain.chainId, end - 3600, 100, 100);
      insert.run(pending.chain.chainId, end - 3600, 1_000_000, 1_000_000);
      const admitted = await loadDdrContext(db, [activeRow()], NOW_SEC);
      if (admitted.kind !== "ok") throw new Error(admitted.reason);
      expect(admitted.context.mintBurnCoveredEventIds.has(activeRow().id)).toBe(true);
      expect(admitted.context.mintBurnHourlyByCoin.get("usdc-circle")?.map((row) => row.netFlowUsd)).toEqual([100]);
      sqlite.prepare("INSERT INTO mint_burn_publication_policy (id, disabled_keys, updated_at) VALUES (1, ?, ?)")
        .run(JSON.stringify(configs.map(mintBurnConfigKey)), NOW_SEC);
      const disabled = await loadDdrContext(db, [activeRow()], NOW_SEC);
      if (disabled.kind !== "ok") throw new Error(disabled.reason);
      expect(disabled.context.mintBurnCoveredEventIds.size).toBe(0);
      expect(disabled.context.mintBurnHourlyByCoin.size).toBe(0);
    } finally { MINT_BURN_CONFIGS.splice(MINT_BURN_CONFIGS.indexOf(pending), 1); }
  });

  it("classifies historical and active coins from the same run-local admitted posture", async () => {
    const { sqlite, db } = fixtures.open();
    seedResolverInputs(sqlite);
    seedHistoricalEvent(sqlite, { id: 1, coin: "usdc-circle", startedAt });
    const card = makeWorkerV9Card({ id: "usdc-circle" });
    if (card.breakdowns?.control == null) throw new Error("Missing fixture control breakdown");
    card.breakdowns.control.components = card.breakdowns.control.components.map((component) => ({
      ...component, posture: "bounded-admin",
    }));
    const snapshot = makeWorkerReportCardsV9Response({ updatedAt: NOW_SEC, cards: [card] });
    const source = vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreCohort").mockResolvedValue({ kind: "v9", snapshot });
    const meta = WORKER_TRACKED_META_BY_ID.get("usdc-circle");
    if (!meta) throw new Error("Missing USDC fixture metadata");
    expect(structuralClass(toStructural(meta, null))).toBe("fragile");
    const loaded = await loadDdrContext(db, [activeRow()], NOW_SEC);
    if (loaded.kind !== "ok") throw new Error(loaded.reason);
    expect(loaded.context.incidents[0].structural).toBe("robust");
    expect(structuralClass(toStructural(meta, loaded.context.structuralContext))).toBe("robust");
    source.mockResolvedValue({ kind: "error", reason: "v9-snapshot-unavailable", detail: "fixture", snapshot: null });
    const unavailable = await loadDdrContext(db, [activeRow()], NOW_SEC);
    if (unavailable.kind !== "ok") throw new Error(unavailable.reason);
    expect(unavailable.context.structuralContext).toBeNull();
    expect(unavailable.context.incidents[0].structural).toBe("fragile");
    expect(structuralClass(toStructural(meta, loaded.context.structuralContext))).toBe("robust");
  });

  it.each([
    ["6.95", "6.92", false],
    ["6.95", "6.94", true],
    ["3.2", "3.1", true],
  ] as const)("admits 7d/30d TVL by stored epochs %s/%s without suppressing volume", async (current, historical, comparable) => {
    const { sqlite, db } = fixtures.open();
    seedResolverInputs(sqlite);
    sqlite.prepare("INSERT INTO dex_liquidity (stablecoin_id, symbol, total_tvl_usd, total_volume_24h_usd, liquidity_score, updated_at, methodology_version) VALUES ('usdc-circle', 'USDC', 200, 300, 80, ?, ?)")
      .run(NOW_SEC, current);
    const insert = sqlite.prepare("INSERT INTO dex_liquidity_history (stablecoin_id, total_tvl_usd, total_volume_24h_usd, snapshot_date, coverage_class, coverage_confidence, methodology_version) VALUES ('usdc-circle', 100, 100, ?, 'primary', 0.9, ?)");
    for (const days of [7, 30]) insert.run(NOW_SEC - days * 86400, historical);
    const loaded = await loadDdrContext(db, [activeRow()], NOW_SEC);
    expect(loaded.kind).toBe("ok");
    if (loaded.kind !== "ok") throw new Error(loaded.reason);
    expect(loaded.context.liqTvlChange7dByCoin.get("usdc-circle")).toBe(comparable ? 100 : undefined);
    expect(loaded.context.liqTvlChange30dByCoin.get("usdc-circle")).toBe(comparable ? 100 : undefined);
    expect(loaded.context.liqVolumeChange30dByCoin.get("usdc-circle")).toBe(200);
    expect(loaded.context.liqByCoin.get("usdc-circle")?.liquidity_score).toBe(80);
  });

  it("measures active-event TVL change against the onset baseline", async () => {
    const { sqlite, db } = fixtures.open();
    seedResolverInputs(sqlite);
    const active = activeRow();
    sqlite.prepare("INSERT INTO dex_liquidity (stablecoin_id, symbol, total_tvl_usd, total_volume_24h_usd, liquidity_score, updated_at, methodology_version) VALUES ('usdc-circle', 'USDC', 200, 300, 80, ?, '6.95')")
      .run(NOW_SEC);
    sqlite.prepare("INSERT INTO dex_liquidity_history (stablecoin_id, total_tvl_usd, total_volume_24h_usd, snapshot_date, coverage_class, coverage_confidence, methodology_version) VALUES ('usdc-circle', 100, 100, ?, 'primary', 0.9, '6.94')")
      .run(active.started_at);

    const loaded = await loadDdrContext(db, [active], NOW_SEC);
    expect(loaded.kind).toBe("ok");
    if (loaded.kind !== "ok") throw new Error(loaded.reason);
    expect(loaded.context.liqTvlChangeSinceOnsetByEventId.get(active.id)).toBe(100);
  });

  it("dates an unrecovered incident from the registry's day-precision frozenAt", async () => {
    const { sqlite, db } = fixtures.open();
    seedResolverInputs(sqlite);
    const startedAt = Math.floor(Date.UTC(2026, 3, 27, 12, 0, 0) / 1000);
    seedHistoricalEvent(sqlite, { id: 7, coin: "usr-resolv", startedAt });
    sqlite.prepare("UPDATE depeg_events SET ended_at = NULL, recovery_price = NULL, close_reason = NULL WHERE id = 7").run();
    const meta = WORKER_TRACKED_META_BY_ID.get("usr-resolv");
    if (meta?.frozenAt !== "2026-04-27") throw new Error("USR frozen fixture metadata changed");

    const loaded = await loadDdrContext(db, [activeRow()], NOW_SEC);
    expect(loaded.kind).toBe("ok");
    if (loaded.kind !== "ok") throw new Error(loaded.reason);
    expect(loaded.context.incidents.find((incident) => incident.stablecoinId === "usr-resolv")).toMatchObject({
      recovered: false,
      terminalAt: Math.floor(Date.UTC(2026, 3, 27) / 1000),
    });
  });

  it("records cache-unavailable safety provenance when the V9 cohort read fails", async () => {
    const { sqlite, db } = fixtures.open();
    seedResolverInputs(sqlite);
    vi.spyOn(activeSafetyScoreSource, "loadActiveSafetyScoreCohort")
      .mockRejectedValue(new Error("cohort read failed"));

    const loaded = await loadDdrContext(db, [activeRow()], NOW_SEC);
    expect(loaded.kind).toBe("ok");
    if (loaded.kind !== "ok") throw new Error(loaded.reason);
    expect(loaded.context.safetyContext).toEqual({
      status: "cache-unavailable",
      reason: "safety-score-v9-read-failed",
      identity: null,
    });
    expect(loaded.context.safetyByCoin.size).toBe(0);
    expect(loaded.context.structuralContext).toBeNull();
  });

  it("loads timed onset and later severity without leaking final peaks into earlier landmarks", async () => {
    const { sqlite, db } = fixtures.open();
    seedResolverInputs(sqlite);
    for (let index = 0; index < 12; index++) {
      seedHistoricalEvent(sqlite, { id: index + 1, coin: `timed-${index}`, startedAt, latePeak: true });
    }
    const loaded = await loadDdrContext(db, [activeRow()], NOW_SEC);
    expect(loaded.kind).toBe("ok");
    if (loaded.kind !== "ok") throw new Error(loaded.reason);
    const { incidents, quarantined, lineage } = loaded.context;
    expect(lineage.eventCount).toBe(12);
    expect(incidents[0].fragments).toEqual(expect.arrayContaining([
      { offsetSec: 0, peakDeviationBps: -500 },
      { offsetSec: 300, peakDeviationBps: -600 },
      { offsetSec: 48 * 3600, peakDeviationBps: -9000 },
    ]));
    expect(incidents[0].fragments).not.toContainEqual({ offsetSec: 0, peakDeviationBps: -9000 });
    expect(incidents[0].fragments?.some((point) => point.peakDeviationBps === -9900)).toBe(false);
    const early = computeDuration(key, 3600, incidents, quarantined);
    const later = computeDuration(key, 49 * 3600, incidents, quarantined);
    expect(early.stratum).toContain("moderate+severe+catastrophic");
    expect(later.stratum).toBe("below · catastrophic · fragile · USD");
    expect(later.suppressed).toBe(false);
  });

  it("removes every excluded audit verdict from context lineage and duration support", async () => {
    const { sqlite, db } = fixtures.open();
    seedResolverInputs(sqlite);
    for (let index = 0; index < 12; index++) {
      seedHistoricalEvent(sqlite, { id: index + 1, coin: `eligible-${index}`, startedAt,
        verdict: index % 3 === 0 ? "confirmed" : index % 3 === 1 ? "repaired" : null });
    }
    const baseline = await loadDdrContext(db, [activeRow()], NOW_SEC);
    expect(baseline.kind).toBe("ok");
    if (baseline.kind !== "ok") throw new Error(baseline.reason);
    for (const [index, verdict] of [...DDR_INELIGIBLE_AUDIT_VERDICTS, "unknown-verdict"].entries()) {
      seedHistoricalEvent(sqlite, { id: 100 + index, coin: `excluded-${verdict}`, startedAt, verdict });
    }
    expect(() => sqlite.prepare(
      "INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at) VALUES (12, 'live', 'unknown-verdict', ?, ?)",
    ).run(NOW_SEC, NOW_SEC)).toThrow("unknown depeg audit verdict");
    const filtered = await loadDdrContext(db, [activeRow()], NOW_SEC);
    expect(filtered.kind).toBe("ok");
    if (filtered.kind !== "ok") throw new Error(filtered.reason);
    expect(filtered.context.lineage).toEqual(baseline.context.lineage);
    expect(filtered.context.incidents).toEqual(baseline.context.incidents);
    expect(computeDuration({ ...key, depth: "moderate" }, 3600, filtered.context.incidents, filtered.context.quarantined))
      .toEqual(computeDuration({ ...key, depth: "moderate" }, 3600, baseline.context.incidents, baseline.context.quarantined));
  });

  it("filters audited-out episodes before the historical row cap", async () => {
    const { sqlite, db } = fixtures.open();
    sqlite.exec(`
      WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id + 1 FROM n WHERE id < ${HISTORICAL_ROW_CAP})
      INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, recovery_price, peg_reference, source)
      SELECT id, 'excluded-' || id, 'FIX', 'peggedUSD', 'below', -500, ${startedAt - 86400}, ${startedAt}, 0.95, 1, 1, 'live' FROM n;
      INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at)
      SELECT id, 'live', 'false_positive', ${NOW_SEC}, ${NOW_SEC} FROM depeg_events;
    `);
    seedHistoricalEvent(sqlite, { id: HISTORICAL_ROW_CAP + 1, coin: "late-eligible", startedAt, verdict: "confirmed" });
    const loaded = await loadDdrHistoricalEvents(db, ["below"], NOW_SEC - TRAINING_WINDOW_SEC);
    expect(loaded.historical.map((event) => event.stablecoinId)).toEqual(["late-eligible"]);
    expect(loaded.trainingRowsTruncated).toBe(false);
  });

  it("leaves legacy, ambiguous promotion, and aggregate-only assessment evidence unsupported", async () => {
    const { sqlite, db } = fixtures.open();
    seedHistoricalEvent(sqlite, { id: 1, coin: "legacy", startedAt, timed: false });
    seedAssessmentSample(sqlite, 1, "legacy", startedAt, startedAt + 300, -9000);
    sqlite.prepare("UPDATE depeg_resolver_assessments SET row_json = ? WHERE event_id = 1")
      .run(JSON.stringify({ peakDeviationBps: -9000 }));
    seedHistoricalEvent(sqlite, { id: 2, coin: "ambiguous", startedAt });
    sqlite.exec("INSERT INTO depeg_pending_outcomes (stablecoin_id, symbol, peg_type, direction, reason, first_seen_bps, first_seen_at, first_price, peg_reference, outcome, outcome_at, final_decision_reason, created_at) " +
      `SELECT stablecoin_id, symbol, peg_type, direction, reason, first_seen_bps, first_seen_at, first_price, peg_reference, outcome, outcome_at, final_decision_reason, created_at FROM depeg_pending_outcomes WHERE stablecoin_id = 'ambiguous'`);
    const loaded = await loadDdrHistoricalEvents(db, ["below"], NOW_SEC - TRAINING_WINDOW_SEC);
    const incidents = groupIncidents(loaded.historical, () => "USD");
    expect(incidents.every((incident) => incident.fragments?.length === 0)).toBe(true);
    expect(computeDuration(key, 3600, incidents, new Set()).horizons.every((cell) => cell.rawAtRisk === 0)).toBe(true);
  });
});
