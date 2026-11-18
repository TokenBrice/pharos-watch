import { summarizeDexVolumeWindow } from "@shared/lib/dex-volume-availability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { createSqliteD1 } from "@shared/test-utils/sqlite-d1";
import { computeDuration, groupIncidents, structuralClass, type DdrStratumKey } from "@shared/lib/depeg-resolver";
import { LIQUIDITY_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { DDR_INELIGIBLE_AUDIT_VERDICTS } from "@shared/types/depeg-audit";
import { buildCurrentDeviationMap, loadDdrContext, loadDdrHistoricalEvents } from "../context";
import {
  CURRENT_PRICE_MAX_AGE_SEC,
  DDR_SNAPSHOT_TTL_SEC,
  DEWS_MAX_AGE_SEC,
  DEX_LIQUIDITY_MAX_AGE_SEC,
  HISTORICAL_ROW_CAP,
  TRAINING_WINDOW_SEC,
} from "../constants";
import { buildDiagnosticSnapshot, buildDdrResponse } from "../public-projection";
import { buildSupplyContext, resolveDdrIncidents } from "../incident-resolution";
import {
  activeInput,
  activeRow,
  loadedContext,
  mockResolverD1,
  NOW_SEC,
  stablecoinsCache,
} from "./depeg-resolver.test-support";
import { seedAssessmentSample, seedHistoricalEvent, seedResolverInputs } from "./context.test-support";
import { WORKER_TRACKED_META_BY_ID } from "@shared/lib/stablecoins/worker-runtime-registry";
import * as activeSafetyScoreSource from "../../../lib/safety-score-active-source";
import { makeWorkerReportCardsV9Response, makeWorkerV9Card } from "../../../test-helpers/report-cards-v9";
import { toStructural } from "../utils";
import { MINT_BURN_CONFIGS } from "../../../lib/mint-burn-contracts";
import { mintBurnConfigKey } from "../../../lib/mint-burn-contract-identity";
import { mintBurnScanCoverageStatements, mintBurnScanFingerprint } from "../../../lib/mint-burn-pipeline/scan-coverage";
import * as mintBurnFlowsService from "../../../lib/mint-burn-flows-service";

const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => {
  fixtures.closeAll();
  vi.restoreAllMocks();
});
const startedAt = NOW_SEC - 10 * 86400;
const key: DdrStratumKey = { direction: "below", depth: "catastrophic", structural: "fragile", currency: "USD" };

function dexClock(asOfSec: number, volumeUsd = 100): string {
  const pool = { observedAtSec: asOfSec, volumeUsd, tvlUsd: 100 };
  return JSON.stringify({ "24h": summarizeDexVolumeWindow([pool], "24h", { asOfSec, maxObservationAgeSec: 3600 }).availability });
}

describe("DDR historical context", () => {
  it("excludes pending and disabled legs from both mint-surge rows and its scan proof", async () => {
    const { sqlite, db } = fixtures.open();
    seedResolverInputs(sqlite);
    const event = activeRow({ stablecoin_id: "usdt-tether", symbol: "USDT" });
    const configs = MINT_BURN_CONFIGS.filter((config) => config.stablecoinId === "usdt-tether");
    const pending = { ...configs[0], chain: { ...configs[0].chain, chainId: "synthetic-pending" } };
    const end = Math.floor(event.started_at / 3600) * 3600;
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
        VALUES ('usdt-tether', ?, ?, 1, 0, 0, 0, ?, 0, ?)`);
      insert.run(configs[0].chain.chainId, end - 3600, 100, 100);
      insert.run(pending.chain.chainId, end - 3600, 1_000_000, 1_000_000);
      const admitted = await loadDdrContext(db, [event], NOW_SEC);
      if (admitted.kind !== "ok") throw new Error(admitted.reason);
      expect(admitted.context.mintBurnCoveredEventIds.has(event.id)).toBe(true);
      expect(admitted.context.mintBurnHourlyByCoin.get("usdt-tether")?.map((row) => row.netFlowUsd)).toEqual([100]);
      const scope = await mintBurnFlowsService.readMintBurnWindowContext(db, NOW_SEC, MINT_BURN_CONFIGS);
      vi.spyOn(mintBurnFlowsService, "readMintBurnWindowContext").mockResolvedValueOnce({ ...scope, partialCoinIds: new Set(["usdt-tether"]) });
      const partial = await loadDdrContext(db, [event], NOW_SEC);
      if (partial.kind !== "ok") throw new Error(partial.reason);
      expect(partial.context.mintBurnCoveredEventIds.size).toBe(0);
      sqlite.exec("UPDATE mint_burn_hourly SET mint_unresolved_event_count = 0, burn_unresolved_event_count = 1 WHERE chain_id = 'ethereum'");
      const unresolved = await loadDdrContext(db, [event], NOW_SEC);
      if (unresolved.kind !== "ok") throw new Error(unresolved.reason);
      expect(unresolved.context.mintBurnCoveredEventIds.size).toBe(0);
      sqlite.prepare("INSERT INTO mint_burn_publication_policy (id, disabled_keys, updated_at) VALUES (1, ?, ?)")
        .run(JSON.stringify(configs.map(mintBurnConfigKey)), NOW_SEC);
      const disabled = await loadDdrContext(db, [event], NOW_SEC);
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
    sqlite.prepare("INSERT INTO dex_liquidity (stablecoin_id, symbol, total_tvl_usd, total_volume_24h_usd, liquidity_score, updated_at, methodology_version, volume_availability_json) VALUES ('usdc-circle', 'USDC', 200, 300, 80, ?, ?, ?)")
      .run(NOW_SEC, current, dexClock(NOW_SEC - 1800, 300));
    const insert = sqlite.prepare("INSERT INTO dex_liquidity_history (stablecoin_id, total_tvl_usd, total_volume_24h_usd, snapshot_date, coverage_class, coverage_confidence, methodology_version, volume_availability_json) VALUES ('usdc-circle', 100, 100, ?, 'primary', 0.9, ?, ?)");
    for (const days of [7, 30]) insert.run(NOW_SEC - days * 86400, historical, dexClock(NOW_SEC - days * 86400 - 1800));
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
    sqlite.prepare("INSERT INTO dex_liquidity (stablecoin_id, symbol, total_tvl_usd, total_volume_24h_usd, liquidity_score, updated_at, methodology_version, volume_availability_json) VALUES ('usdc-circle', 'USDC', 200, 300, 80, ?, '6.95', ?)")
      .run(NOW_SEC, dexClock(NOW_SEC - 1800, 300));
    const insert = sqlite.prepare(`INSERT INTO dex_liquidity_history (stablecoin_id, total_tvl_usd, total_volume_24h_usd, snapshot_date, coverage_class, coverage_confidence, methodology_version, volume_availability_json)
      VALUES ('usdc-circle', ?, 100, ?, 'primary', 0.9, '6.94', ?)`);
    insert.run(100, active.started_at - 86400, dexClock(active.started_at - 1800));
    insert.run(400, active.started_at, dexClock(active.started_at + 1));

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

  it("requires each promoted EURC observation to match its own admitted receipt", async () => {
    const { sqlite, db } = fixtures.open();
    const at = Date.UTC(2026, 10, 14, 12) / 1000;
    seedHistoricalEvent(sqlite, { id: 1, coin: "eurc-circle", startedAt: at });
    sqlite.exec("UPDATE depeg_events SET peg_type = 'peggedEUR'; UPDATE depeg_pending_outcomes SET peg_type = 'peggedEUR'");
    const read = async () => (await loadDdrHistoricalEvents(db, ["below"], at - 1)).historical[0];
    const write = (onset: unknown, latest: unknown) => sqlite.prepare("UPDATE depeg_events SET peer_basis_json = ?")
      .run(JSON.stringify({ onset, latest }));
    const onset = { basis: "native-peg", venue: "kraken", pegReference: 1, observedAt: at, price: 0.95, bps: -500 };
    const latest = { ...onset, observedAt: at + 300, price: 0.94, bps: -600 };
    expect(await read()).toMatchObject({ onsetDeviationBps: -500,
      severityObservations: [{ observedAt: at + 300, deviationBps: -600 }] });
    seedAssessmentSample(sqlite, 1, "eurc-circle", at, at + 120, -550);
    write({}, {});
    expect(await read()).toMatchObject({ onsetDeviationBps: null, severityObservations: [] });
    write(onset, { ...latest, observedAt: at });
    expect(await read()).toMatchObject({ onsetDeviationBps: -500, severityObservations: [] });
    write({ ...onset, basis: "benchmark" }, latest);
    expect(await read()).toMatchObject({ onsetDeviationBps: null,
      severityObservations: [{ observedAt: at + 300, deviationBps: -600 }] });
    sqlite.exec("UPDATE depeg_events SET peer_basis_json = NULL, peg_type = 'peggedUSD'; UPDATE depeg_pending_outcomes SET peg_type = 'peggedUSD'");
    expect(await read()).toMatchObject({ onsetDeviationBps: null, severityObservations: [] });
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

  it.each([
    ["peggedGOLD", "xaut-tether", 240],
    ["peggedGOLD", "xaut-tether", -1],
    ["peggedGOLD", "xaut-tether", 301],
    ["peggedUSD", "usdc-circle", 240],
  ] as const)("preserves the stored %s quote and gates %s at assessment for onset +%d", async (pegType, coin, quoteOffset) => {
    const { sqlite, db } = fixtures.open();
    seedHistoricalEvent(sqlite, { id: 1, coin, startedAt, timed: false });
    sqlite.prepare("UPDATE depeg_events SET peg_type = ? WHERE id = 1").run(pegType);
    seedAssessmentSample(sqlite, 1, coin, startedAt, startedAt + 300, -320);
    const assertTraining = async (expected: readonly unknown[]) => {
      const { historical } = await loadDdrHistoricalEvents(db, ["below"], NOW_SEC - TRAINING_WINDOW_SEC);
      expect(historical[0]?.severityObservations).toEqual(expected);
      const incidents = groupIncidents(historical, () => pegType === "peggedUSD" ? "USD" : "GOLD");
      const cohortKey = { ...key, depth: "moderate", currency: pegType === "peggedUSD" ? "USD" : "non-USD" } as const;
      expect(computeDuration(cohortKey, 270, incidents, new Set(), NOW_SEC).horizons[0].rawAtRisk).toBe(0);
      expect(computeDuration(cohortKey, 300, incidents, new Set(), NOW_SEC).horizons[0].rawAtRisk).toBe(expected.length);
    };
    await assertTraining([{ observedAt: startedAt + 300, deviationBps: -320 }]);
    sqlite.prepare("UPDATE depeg_resolver_assessments SET row_json = json_set(row_json, '$.currentDeviationObservedAtSec', ?) WHERE event_id = 1")
      .run(startedAt + quoteOffset);
    const stored = sqlite.prepare("SELECT severity_observations_json FROM depeg_resolver_training_corpus WHERE event_id = 1").get();
    expect(JSON.parse(String(stored?.severity_observations_json))).toEqual([
      expect.objectContaining({ observedAt: startedAt + 300, deviationBps: -320 }),
    ]);
    const expected = quoteOffset === 240 ? [{ observedAt: startedAt + 240, availableAt: startedAt + 300, deviationBps: -320 }] : [];
    await assertTraining(expected);
    sqlite.exec("DELETE FROM depeg_resolver_training_corpus WHERE event_id = 1");
    await assertTraining(expected);
    sqlite.exec("UPDATE depeg_events SET ended_at = NULL WHERE id = 1");
    await assertTraining(expected);
  });
});

describe("DDR supply history provenance", () => {
  it.each([900, null])("withholds a same-day replacement when the quantity observation offset is %j", async (replacementOffset) => {
    const { sqlite, db } = fixtures.open();
    seedResolverInputs(sqlite);
    if (!sqlite.prepare("SELECT name FROM pragma_table_info('supply_history') WHERE name = 'circulating_native'").get()) {
      sqlite.exec("ALTER TABLE supply_history ADD COLUMN circulating_native REAL");
    }
    const midnight = Math.floor(startedAt / 86_400) * 86_400;
    const onset = midnight + 300;
    const insert = sqlite.prepare(`INSERT OR REPLACE INTO supply_history
      (stablecoin_id, snapshot_date, circulating_usd, circulating_native, supply_provenance)
      VALUES ('usdc-circle', ?, ?, ?, ?)`);
    const provenance = (supplyObservedAt: number | null) =>
      JSON.stringify({ supplySource: "onchain-total-supply", supplyObservedAt, supplyChainGuard: null });
    const baseline = midnight - 7 * 86_400;
    insert.run(baseline, 1_000_000, 100, provenance(baseline + 60));
    insert.run(midnight, 900_000, 90, provenance(onset));
    const resolve = async () => {
      const loaded = await loadDdrContext(db, [activeRow({ started_at: onset })], NOW_SEC);
      if (loaded.kind !== "ok") throw new Error(loaded.reason);
      return resolveDdrIncidents(loaded.context, NOW_SEC)[0];
    };
    expect((await resolve()).relatedContext.supplyChange7dPct).toBe(-10);
    insert.run(midnight, 880_000, 88, provenance(replacementOffset == null ? null : midnight + replacementOffset));
    const replaced = await resolve();
    expect(replaced.relatedContext.supplyChange7dPct).toBeNull();
    expect(replaced.resolution.factors.some((factor) => factor.code === "R3_no_supply_anomaly")).toBe(false);
  });

  it("keeps USD inputs on the unchanged pre-0306 schema and degrades on a failed USD read", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      const migrations = resolvePath(__dirname, "../../../../migrations");
      for (const file of readdirSync(migrations).filter((name) => /^\d{4}_.*\.sql$/.test(name) && Number(name.slice(0, 4)) < 306).sort()) {
        sqlite.exec(readFileSync(resolvePath(migrations, file), "utf8"));
      }
      seedResolverInputs(sqlite);
      const event = activeRow();
      const insert = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd) VALUES (?, ?, ?)");
      const baseline = event.started_at - 7 * 86_400;
      insert.run(event.stablecoin_id, baseline, 1_100_000);
      insert.run(event.stablecoin_id, event.started_at, 1_000_000);
      const db = createSqliteD1(sqlite);
      const usdt = activeRow({ id: 102, stablecoin_id: "usdt-tether", symbol: "USDT" });
      const ousd = activeRow({ id: 103, stablecoin_id: "ousd-origin-protocol", symbol: "OUSD" });
      const windowEnd = Math.floor(event.started_at / 3600) * 3600;
      const hourly = sqlite.prepare(`INSERT INTO mint_burn_hourly
        (stablecoin_id, chain_id, hour_ts, mint_count, burn_count, mint_unpriced_event_count, burn_unpriced_event_count,
         mint_unresolved_event_count, burn_unresolved_event_count, mint_volume_usd, burn_volume_usd, net_flow_usd)
        VALUES (?, 'ethereum', ?, 1, 0, 0, 0, 0, 0, 100, 0, 100)`);
      for (const coin of [usdt, ousd]) {
        hourly.run(coin.stablecoin_id, windowEnd - 3600);
        for (const config of MINT_BURN_CONFIGS.filter((leg) => leg.stablecoinId === coin.stablecoin_id)) {
          await db.batch(mintBurnScanCoverageStatements(db, {
            configKey: mintBurnConfigKey(config), configFingerprint: mintBurnScanFingerprint(config), chainId: config.chain.chainId,
            fromBlock: 1, toBlock: 2, finalizedBlock: 2, fromTimestamp: windowEnd - 7 * 86400, toTimestamp: NOW_SEC, acceptedAt: NOW_SEC,
          }));
        }
      }
      const loaded = await loadDdrContext(db, [event, usdt, ousd], NOW_SEC);
      if (loaded.kind !== "ok") throw new Error(loaded.reason);
      expect(loaded.context.mintBurnCoveredEventIds).toEqual(new Set([usdt.id]));
      expect(loaded.context.mintBurnHourlyByCoin.get(usdt.stablecoin_id)?.map((row) => row.netFlowUsd)).toEqual([100]);
      expect(loaded.context.mintBurnHourlyByCoin.has(ousd.stablecoin_id)).toBe(false);
      const snapshots = loaded.context.supplyByCoin.get(event.stablecoin_id) ?? [];
      expect(snapshots).toEqual([
        { date: baseline, usd: 1_100_000 },
        { date: event.started_at, usd: 1_000_000 },
      ]);
      expect(resolveDdrIncidents(loaded.context, NOW_SEC)[0].inputs).toMatchObject({
        circulatingUsd: 1_000_000,
        supply: { covered: true, change7dPct: (-100_000 / 1_100_000) * 100, mintSurge: null, mintSurgeCoverage: "unavailable" },
      });
      expect(buildSupplyContext(snapshots, event.started_at, NOW_SEC, [], true)).toMatchObject({
        covered: true, change7dPct: (-100_000 / 1_100_000) * 100, mintSurge: false, mintSurgeCoverage: "mint-burn-hourly",
      });

      const unavailable = createSqliteD1(sqlite, { onAll(sql) {
        if (sql.includes("FROM supply_history h")) throw new Error("read unavailable");
      } });
      await expect(loadDdrContext(unavailable, [event], NOW_SEC)).resolves.toMatchObject({
        kind: "degraded", reason: expect.stringContaining("supply_history:read unavailable"),
      });
      const failedScan = createSqliteD1(sqlite, { onRun(sql) {
        if (sql.includes("pharos:mint-burn-scan-coverage:read")) throw new Error("read unavailable");
      } });
      await expect(loadDdrContext(failedScan, [event], NOW_SEC)).resolves.toMatchObject({
        kind: "degraded", reason: "mint_burn_hourly:read unavailable",
      });
    } finally {
      sqlite.close();
    }
  });
});

describe("resolver source-owned time budgets", () => {
  it.each([0, 1])("admits producer-cadence current prices inclusively and rejects age budget + %s", async (extraAge) => {
    const updatedAt = NOW_SEC - CURRENT_PRICE_MAX_AGE_SEC - extraAge;
    const db = mockResolverD1([stablecoinsCache(updatedAt)]);
    const result = await buildCurrentDeviationMap(db, NOW_SEC);
    expect(result.dataAsOf).toBe(updatedAt);
    if (extraAge === 0) {
      expect(result.healthy).toBe(true);
      expect(result.degradedReason).toBeNull();
      expect(result.byCoin.get("usdc-circle")).toBe(-300);
    } else {
      expect(result.healthy).toBe(false);
      expect(result.degradedReason).toBe("stablecoins-cache-stale");
      expect(result.byCoin.size).toBe(0);
    }
  });

  it("carries the training window and publication TTL into diagnostic and public snapshots", () => {
    const lineage = {
      trainingWindow: { start: NOW_SEC - TRAINING_WINDOW_SEC, end: NOW_SEC },
      eventCount: 0,
      incidentCount: 0,
      coinCount: 0,
      quarantinedCoins: 0,
      trainingRowsTruncated: false,
    };
    expect(lineage.trainingWindow).toEqual({ start: NOW_SEC - TRAINING_WINDOW_SEC, end: NOW_SEC });
    const diagnostic = buildDiagnosticSnapshot({ rows: [], lineage, nowSec: NOW_SEC });
    const published = buildDdrResponse({ candidateRows: [], incidentsByEventId: new Map(), sealed: [], firstPublication: [],
      manifest: null, errata: [], lineage, nowSec: NOW_SEC });
    for (const snapshot of [diagnostic, published]) {
      expect(snapshot._meta.computedAt).toBe(NOW_SEC);
      expect(snapshot._meta.expiresAt).toBe(NOW_SEC + DDR_SNAPSHOT_TTL_SEC);
      expect(snapshot._meta.lineage?.trainingWindow).toEqual(lineage.trainingWindow);
    }
  });

  it.each([0, 1])("expires DEWS and liquidity context at each source budget + %s", (extraAge) => {
    const active = activeInput();
    const context = loadedContext({
      dewsByCoin: new Map([[active.stablecoinId, {
        stablecoin_id: active.stablecoinId, score: 80, band: "DANGER", signals_json: "{}",
        computed_at: NOW_SEC - DEWS_MAX_AGE_SEC - extraAge,
      }]]),
      liqByCoin: new Map([[active.stablecoinId, {
        stablecoin_id: active.stablecoinId, liquidity_score: 10, concentration_hhi: 0.9,
        total_tvl_usd: 10, total_volume_24h_usd: 5, updated_at: NOW_SEC - DEX_LIQUIDITY_MAX_AGE_SEC - extraAge,
        methodology_version: LIQUIDITY_METHODOLOGY_VERSION,
      }]]),
    });
    const [row] = resolveDdrIncidents(context, NOW_SEC);
    expect(row.relatedContext.dewsScore).toBe(extraAge === 0 ? 80 : null);
    expect(row.relatedContext.dewsBand).toBe(extraAge === 0 ? "DANGER" : null);
    expect(row.relatedContext.liquidityScore).toBe(extraAge === 0 ? 10 : null);
  });
});
