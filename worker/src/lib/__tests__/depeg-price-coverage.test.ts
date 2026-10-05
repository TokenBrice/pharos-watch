import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "@shared/test-utils/latest-schema-sqlite";
import { advanceDepegPriceCoverage } from "@shared/lib/depeg-price-coverage";
import { computePegScore, computeRecentPegStats } from "@shared/lib/peg-score";
import { mergeDepegSeconds, mergeUnknownDepegSeconds } from "@shared/lib/peg-utils";
import { DEPEG_EVENT_MIN_SUPPLY_USD } from "@shared/lib/depeg-config";
import { decideDepegAsset } from "../../cron/depeg-detection/decision-engine";
import type { DepegEvent } from "@shared/types/market";
import type { DepegPriceCoverage } from "@shared/types/peg";
import type { StablecoinMeta } from "@shared/types/core";
import { persistDepegCommands } from "../../cron/depeg-detection/persistence";
import { rowToDepegEvent, type DepegRow } from "../depeg-helpers";

const DAY = 86400;
const NOW = 1_790_985_600;
const meta = {
  id: "usda-avalon", symbol: "USDA", name: "Avalon USDa",
  flags: { navToken: false, pegCurrency: "USD" },
} as StablecoinMeta;
const readRow = (sqlite: DatabaseSync) => sqlite.prepare("SELECT * FROM depeg_events WHERE id = 1").get() as unknown as DepegRow;
const oldInsert = `INSERT INTO depeg_events (id, stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
  started_at, start_price, peak_price, peg_reference, source, confirmation_sources, pending_reason)
  VALUES (1, 'usda-avalon', 'USDA', 'peggedUSD', 'below', -2000, ?, 0.8, 0.8, 1, 'live', NULL, NULL)`;

function eventWithCoverage(coverage: DepegPriceCoverage | null, startedAt = NOW - DAY): DepegEvent {
  return {
    id: 1, stablecoinId: "usda-avalon", symbol: "USDA", pegType: "peggedUSD", direction: "below",
    startedAt, endedAt: null, peakDeviationBps: -2000, startPrice: 0.8, peakPrice: 0.8,
    recoveryPrice: null, pegReference: 1, source: "live", confirmationSources: null,
    pendingReason: null, closeReason: null, provenance: null, priceCoverage: coverage,
  };
}

describe("trusted depeg price coverage", () => {
  it("does not accrue off-peg seconds across explicit or missed-run gaps", () => {
    let coverage = advanceDepegPriceCoverage(null, NOW, "trusted-off-peg");
    coverage = advanceDepegPriceCoverage(coverage, NOW + 900, "trusted-off-peg");
    coverage = advanceDepegPriceCoverage(coverage, NOW + 1800, "blind");
    coverage = advanceDepegPriceCoverage(coverage, NOW + 2700, "trusted-off-peg");
    coverage = advanceDepegPriceCoverage(coverage, NOW + 3600, "trusted-off-peg");
    coverage = advanceDepegPriceCoverage(coverage, NOW + 6300, "trusted-off-peg");
    expect(coverage.intervals).toEqual([[NOW, NOW + 900], [NOW + 2700, NOW + 3600], [NOW + 6300, NOW + 6300]]);
    const event = eventWithCoverage(coverage, NOW);
    expect(mergeDepegSeconds([event], NOW, NOW + 7200)).toBe(1800);
    expect(mergeUnknownDepegSeconds([event], NOW, NOW + 7200)).toBe(5400);
  });

  it("does not invent legacy-open duration or credit blind time as verified stability", () => {
    const legacy = eventWithCoverage(null, NOW - 30 * DAY);
    const score = computePegScore([legacy], legacy.startedAt, NOW);
    expect(score.pegScore).toBeNull();
    expect(score.unknownCoverageSeconds).toBe(30 * DAY);
    expect(score.pegPct).toBeNull();
    expect(mergeDepegSeconds([legacy], legacy.startedAt, NOW)).toBe(0);
    const resumed = eventWithCoverage(advanceDepegPriceCoverage(null, NOW, "trusted-off-peg"), legacy.startedAt);
    expect(mergeDepegSeconds([resumed], legacy.startedAt, NOW)).toBe(0);
    expect(computeRecentPegStats([legacy], legacy.startedAt, NOW)).toMatchObject({ observedDays: 0, coverageLimited: true });
    const closedLegacy = { ...legacy, endedAt: NOW - DAY };
    expect(mergeDepegSeconds([closedLegacy], legacy.startedAt, NOW)).toBe(29 * DAY);
  });

  it("does not apply the current-depeg penalty to an unresolved coverage gap", () => {
    const trusted = eventWithCoverage({
      intervals: [[NOW - DAY, NOW]],
      lastTrustedObservationAt: NOW,
      gapStartedAt: null,
    }, NOW - DAY);
    const unresolved = { ...trusted, priceCoverage: { ...trusted.priceCoverage!, gapStartedAt: NOW } };
    const freshScore = computePegScore([trusted], NOW - 30 * DAY, NOW);
    const unresolvedScore = computePegScore([unresolved], NOW - 30 * DAY, NOW);
    expect(unresolvedScore.activeDepeg).toBe(true);
    expect(unresolvedScore.pegPct).toBe(freshScore.pegPct);
    expect(unresolvedScore.pegScore! - freshScore.pegScore!).toBe(40);
  });

  it("preserves the known-time percentage and duration severity when a gap grows", () => {
    const startedAt = NOW - DAY;
    const coverage = advanceDepegPriceCoverage(advanceDepegPriceCoverage(null, startedAt, "trusted-off-peg"), startedAt + 900, "trusted-off-peg");
    const gap = advanceDepegPriceCoverage(coverage, startedAt + 1800, "blind");
    const event = eventWithCoverage(gap, startedAt);
    const atGap = computePegScore([event], NOW - 30 * DAY, NOW);
    const later = computePegScore([event], NOW - 30 * DAY, NOW + DAY);
    expect(later.pegPct).toBe(atGap.pegPct);
    expect(later.unknownCoverageSeconds! - atGap.unknownCoverageSeconds!).toBe(DAY);
    // Recency can decay old evidence; duration cannot manufacture worsening severity.
    expect(later.severityScore).toBeGreaterThanOrEqual(atGap.severityScore);
    expect(later.activeDepeg).toBe(true); // Lifecycle is not a fresh adverse observation.
  });

  it("does not double-count overlapping unknown time or hide trusted intervals under a legacy row", () => {
    const legacy = eventWithCoverage(null, NOW - DAY);
    const covered = eventWithCoverage({ intervals: [[NOW - 1800, NOW - 900]], lastTrustedObservationAt: NOW - 900, gapStartedAt: NOW }, NOW - 1800);
    expect(mergeUnknownDepegSeconds([legacy, covered], NOW - DAY, NOW)).toBe(DAY - 900);
    expect(mergeDepegSeconds([legacy, covered], NOW - DAY, NOW)).toBe(900);
  });

  it("keeps the old Worker's reads and writes compatible during pre-Worker migration", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      const directory = path.resolve("worker/migrations");
      for (const file of readdirSync(directory).filter((file) => file.endsWith(".sql") && file < "0255").sort()) {
        sqlite.exec(readFileSync(path.join(directory, file), "utf8"));
      }
      sqlite.prepare(oldInsert).run(NOW - DAY);
      sqlite.exec(readFileSync(path.join(directory, "0255_depeg_trusted_price_coverage.sql"), "utf8"));
      sqlite.prepare("UPDATE depeg_events SET peak_deviation_bps = ?, peak_price = ? WHERE id = ?").run(-2500, 0.75, 1);
      sqlite.prepare(oldInsert.replace("VALUES (1,", "VALUES (2,")).run(NOW);
      expect(sqlite.prepare("SELECT id, peak_deviation_bps, price_coverage_json, last_trusted_price_at, price_coverage_gap_started_at FROM depeg_events ORDER BY id").all()).toEqual([
        { id: 1, peak_deviation_bps: -2500, price_coverage_json: null, last_trusted_price_at: null, price_coverage_gap_started_at: null },
        { id: 2, peak_deviation_bps: -2000, price_coverage_json: null, last_trusted_price_at: null, price_coverage_gap_started_at: null },
      ]);
      expect(sqlite.prepare("SELECT * FROM depeg_events_with_provenance WHERE ended_at IS NULL").all()).toHaveLength(2);
    } finally { sqlite.close(); }
  });

  it("persists trusted endpoints and price loss without closing the event, while retaining the creation floor", async () => {
    const { sqlite, db } = createLatestSchemaSqlite();
    try {
      sqlite.prepare(oldInsert).run(NOW - DAY);
      const observe = async (now: number, price: number | null, supply = 5_000_000) => {
        const decision = decideDepegAsset({
          now, meta, existing: readRow(sqlite),
          asset: { id: meta.id, symbol: meta.symbol, price, priceSource: "pyth", priceConfidence: "single-source", priceUpdatedAt: now, pegType: "peggedUSD", circulating: { peggedUSD: supply } },
          pegRates: { peggedUSD: 1 }, pegRateSources: { peggedUSD: "median" }, pegRateCounts: { peggedUSD: 3 },
        });
        await persistDepegCommands(db, [
          { type: "record-price-coverage", id: 1, coverage: decision.priceCoverage! },
          ...decision.commands,
        ]);
      };
      await observe(NOW, 0.8);
      await observe(NOW + 900, 0.8);
      await observe(NOW + 1800, null);
      const row = readRow(sqlite);
      expect(row.ended_at).toBeNull();
      expect(row.last_trusted_price_at).toBe(NOW + 900);
      expect(row.price_coverage_gap_started_at).toBe(NOW + 1800);
      const event = rowToDepegEvent(row);
      expect(mergeDepegSeconds([event], NOW - DAY, NOW + 3600)).toBe(900);
      await observe(NOW + 2700, 1);
      await observe(NOW + 3300, 1);
      const recovering = rowToDepegEvent(readRow(sqlite));
      expect(recovering.endedAt).toBeNull();
      expect(recovering.priceCoverage?.lastTrustedObservationAt).toBe(NOW + 3300);
      expect(mergeDepegSeconds([recovering], NOW, NOW + 3300)).toBe(900);
      expect(mergeUnknownDepegSeconds([recovering], NOW, NOW + 3300)).toBe(1800);
      expect(computePegScore([recovering], NOW, NOW + 3300).pegPct).toBe(40);
      const belowFloor = decideDepegAsset({
        now: NOW, meta,
        asset: { id: meta.id, symbol: meta.symbol, price: 0.5, priceSource: "pyth", priceConfidence: "single-source", priceUpdatedAt: NOW, pegType: "peggedUSD", circulating: { peggedUSD: DEPEG_EVENT_MIN_SUPPLY_USD - 1 } },
        pegRates: { peggedUSD: 1 }, pegRateSources: { peggedUSD: "median" }, pegRateCounts: { peggedUSD: 3 },
      });
      expect(belowFloor.commands).toEqual([]);
    } finally { sqlite.close(); }
  });
});
