import type { DatabaseSync } from "node:sqlite";
import { DEPEG_AUDIT_VERDICT_VALUES } from "@shared/types/depeg-audit";
import { buildDewsStablecoinIdsDigest } from "../../../lib/dews-publication-pointer";
import { NOW_SEC } from "./depeg-resolver.test-support";

export function seedResolverInputs(sqlite: DatabaseSync): void {
  const insertCache = sqlite.prepare("INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?)");
  insertCache.run("stablecoins", JSON.stringify({ peggedAssets: [{
    id: "usdc-circle", name: "USD Coin", symbol: "USDC", pegType: "peggedUSD",
    price: 0.97, circulating: { peggedUSD: 1_000_000_000 },
  }] }), NOW_SEC);
  insertCache.run("dews:published-generation", JSON.stringify({
    updatedAt: NOW_SEC, source: "compute-dews", publishStatus: "published", coverageVersion: 2,
    expectedRowCount: 1, stablecoinIdsDigest: buildDewsStablecoinIdsDigest(["usdc-circle"]),
  }), NOW_SEC);
  sqlite.prepare("INSERT INTO stress_signal_publication_rows (stablecoin_id, score, band, signals_json, computed_at) VALUES (?, ?, ?, ?, ?)")
    .run("usdc-circle", 10, "CALM", "{}", NOW_SEC);
}

export function seedHistoricalEvent(sqlite: DatabaseSync, input: {
  id: number;
  coin: string;
  startedAt: number;
  verdict?: string | null;
  timed?: boolean;
  latePeak?: boolean;
}): void {
  const { id, coin, startedAt, verdict, timed = true, latePeak = false } = input;
  const endedAt = startedAt + 72 * 3600;
  sqlite.prepare(
    "INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps, started_at, ended_at, start_price, peak_price, recovery_price, peg_reference, source, close_reason) " +
    "VALUES (?, ?, 'FIX', 'peggedUSD', 'below', ?, ?, ?, 0.95, 0.1, 1, 1, 'live', 'recovered-primary')",
  ).run(id, coin, latePeak ? -9000 : -500, startedAt, endedAt);
  if (verdict != null) {
    const legacyVerdict = !DEPEG_AUDIT_VERDICT_VALUES.some((known) => known === verdict);
    const insertGuard = legacyVerdict
      ? sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
        .get("trg_depeg_provenance_audit_verdict_insert_guard") as { sql: string } | undefined
      : undefined;
    if (legacyVerdict && !insertGuard) throw new Error("Missing audit verdict insert guard");
    // Unknown verdicts can exist only in legacy rows predating the vocabulary guard.
    if (insertGuard) sqlite.exec("DROP TRIGGER trg_depeg_provenance_audit_verdict_insert_guard");
    try {
      sqlite.prepare("INSERT INTO depeg_event_provenance (event_id, source_kind, audit_verdict, created_at, updated_at) VALUES (?, 'live', ?, ?, ?)")
        .run(id, verdict, NOW_SEC, NOW_SEC);
    } finally {
      if (insertGuard) sqlite.exec(insertGuard.sql);
    }
  }
  if (timed) {
    sqlite.prepare(
      "INSERT INTO depeg_pending_outcomes (stablecoin_id, symbol, peg_type, direction, reason, first_seen_bps, first_seen_at, first_price, last_seen_bps, last_seen_at, last_price, peak_seen_bps, peg_reference, outcome, outcome_at, final_decision_reason, created_at) " +
      "VALUES (?, 'FIX', 'peggedUSD', 'below', 'test', -500, ?, 0.95, -600, ?, 0.94, -600, 1, 'promoted', ?, 'confirmed', ?)",
    ).run(coin, startedAt, startedAt + 300, startedAt + 300, startedAt + 300);
  }
  if (latePeak) seedAssessmentSample(sqlite, id, coin, startedAt, startedAt + 48 * 3600, -9000);
}

export function seedAssessmentSample(sqlite: DatabaseSync, eventId: number, coin: string, startedAt: number, observedAt: number, bps: number): void {
  sqlite.prepare(
    "INSERT INTO depeg_resolver_assessments (event_id, stablecoin_id, symbol, name, peg_currency, governance, direction, started_at, assessed_at, event_age_sec, checkpoint, methodology_version, methodology_version_label, resolution_rubric_version, duration_model_version, incident_grouping_version, support_rules_version, resolution_tier, duration_suppressed, horizons_json, factors_json, row_json, created_at, updated_at) " +
    "VALUES (?, ?, 'FIX', 'Fixture', 'USD', 'centralized', 'below', ?, ?, ?, 'latest', '4.4', 'v4.4', 'test', 'test', 'test', 'test', 'at_risk', 1, '[]', '[]', ?, ?, ?)",
  ).run(eventId, coin, startedAt, observedAt, observedAt - startedAt, JSON.stringify({ currentDeviationBps: bps, peakDeviationBps: -9900 }), observedAt, observedAt);
}
