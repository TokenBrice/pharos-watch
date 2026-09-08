import type { DepegRow } from "../../lib/depeg-helpers";
import type { HistoricalMarketSourceDiagnostics } from "../backfill-price-sources";
import { makeDepegRow } from "../../test-helpers/__shared/fixtures";

export function makeAuditEvent(overrides: Partial<DepegRow> = {}): DepegRow & Record<string, unknown> {
  const row = makeDepegRow({
    started_at: 1_800_000_000,
    ended_at: 1_800_003_600,
    recovery_price: 0.999,
  });
  return {
    ...row,
    confirmation_sources: null,
    pending_reason: null,
    ...overrides,
  };
}

export function makeReplayDiagnostics(finalPointCount: number): HistoricalMarketSourceDiagnostics {
  return {
    granularity: "hourly",
    sourcesUsed: ["coingecko"],
    quoteMode: "usd",
    quoteCurrency: "usd",
    mergeReasons: [],
    perSourceStats: [],
    policyAdjustments: [],
    finalPointCount,
  };
}

export function makeBrzBackfillRow(): DepegRow {
  const row = makeDepegRow({
    id: 10, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL",
    direction: "below", peak_deviation_bps: -220,
    started_at: 1_000, ended_at: 2_000,
    start_price: 0.19, peak_price: 0.188, recovery_price: 0.191, peg_reference: 0.193,
    source: "backfill",
  });
  return { ...row, confirmation_sources: null, pending_reason: null };
}
