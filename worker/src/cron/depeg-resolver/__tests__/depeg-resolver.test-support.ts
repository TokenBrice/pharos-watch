import type { MockTableConfig } from "@shared/test-utils/mock-d1";
import type { StablecoinData } from "@shared/types/market";
import type { DdrEventDbRow } from "../types";
import type { DdrCanonicalIncident } from "../../depeg-resolver-v2-contracts";

export function makeEventRow(overrides: Partial<DdrEventDbRow> = {}): DdrEventDbRow {
  return {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "peggedUSD",
    direction: "below",
    peak_deviation_bps: -250,
    started_at: 1_750_000_000,
    ended_at: null,
    recovery_price: null,
    peg_reference: 1,
    source: "live",
    confirmation_sources: null,
    pending_reason: null,
    provenance_replay_run_id: null,
    provenance_replay_version: null,
    ...overrides,
  };
}

export function makeIncident(overrides: Partial<DdrCanonicalIncident> = {}): DdrCanonicalIncident {
  return {
    incidentKey: "ddr2:test-incident-1",
    eventId: 1,
    currentEventId: 1,
    stablecoinId: "usdt-tether",
    pegCurrency: "USD",
    direction: "below",
    startedAt: 1_750_000_000,
    eligibleAt: 1_750_000_000,
    policyUniverseIncluded: true,
    confirmedAt: null,
    lockState: null,
    ...overrides,
  };
}

export function stablecoinsCache(updatedAt: number, overrides: Partial<StablecoinData> = {}): MockTableConfig {
  return {
    match: "FROM cache WHERE key = ?",
    rows: [{
      key: "stablecoins",
      value: JSON.stringify({ peggedAssets: [{
        id: "usdc-circle",
        symbol: "USDC",
        name: "USD Coin",
        pegType: "peggedUSD",
        price: 0.97,
        circulating: { peggedUSD: 1_000_000_000 },
        ...overrides,
      }] }),
      updated_at: updatedAt,
    }],
  };
}
