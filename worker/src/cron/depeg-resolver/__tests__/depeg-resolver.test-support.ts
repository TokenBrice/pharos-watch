import type { DdrActiveEventInput } from "@shared/lib/depeg-resolver";
import { buildDewsStablecoinIdsDigest } from "../../../lib/dews-publication-pointer";
import { mockD1 as createMockD1, type MockTableConfig } from "@shared/test-utils/mock-d1";
import type { StablecoinData } from "@shared/types/market";
import type { DdrLoadedContext } from "../context";
import type { DdrEventDbRow } from "../types";
import type { DdrCanonicalIncident } from "../../depeg-resolver-v2-contracts";

export const NOW_SEC = 1_780_358_400;
export const DAY = 86_400;

export const DEFAULT_DDR_D1_TABLES: MockTableConfig[] = [
  {
    match: "SELECT stablecoin_id, direction, peak_deviation_bps, started_at, ended_at, recovery_price, close_reason FROM depeg_events WHERE ended_at IS NOT NULL",
    rows: [],
    allowUnused: true,
  },
  { match: "FROM supply_history", rows: [], allowUnused: true },
  { match: "FROM mint_burn_hourly", rows: [], allowUnused: true },
  { match: "FROM dex_liquidity", rows: [], allowUnused: true },
  { match: "FROM dex_liquidity_history", rows: [], allowUnused: true },
  { match: "FROM redemption_backstop_runs", rows: [], allowUnused: true },
  { match: "FROM redemption_backstop_run_rows", rows: [], allowUnused: true },
];

export function mockResolverD1(tables: MockTableConfig[] = []) {
  return createMockD1([...tables, ...DEFAULT_DDR_D1_TABLES], { assertMatchesUsed: true });
}

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

export function activeInput(overrides: Partial<DdrActiveEventInput> = {}): DdrActiveEventInput {
  return {
    id: 101,
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "peggedUSD",
    direction: "below",
    peakDeviationBps: -350,
    startedAt: NOW_SEC - DAY,
    pegReference: 1,
    currentDeviationBps: -250,
    ...overrides,
  };
}

export function activeRow(overrides: Partial<DdrEventDbRow> = {}): DdrEventDbRow {
  return makeEventRow({
    id: 101,
    stablecoin_id: "usdc-circle",
    symbol: "USDC",
    peak_deviation_bps: -350,
    started_at: NOW_SEC - DAY,
    ...overrides,
  });
}

export function supplyHistory(startedAt: number) {
  return [
    { date: startedAt - 30 * DAY, usd: 1_000_000_000 },
    { date: startedAt - 7 * DAY, usd: 1_000_000_000 },
    { date: startedAt, usd: 1_000_000_000 },
  ];
}

export function loadedContext(overrides: Partial<DdrLoadedContext> = {}): DdrLoadedContext {
  const active = activeInput();
  return {
    active: [active],
    activeCoinIds: [active.stablecoinId],
    activeEventById: new Map(),
    incidents: [],
    quarantined: new Set(),
    supplyByCoin: new Map([[active.stablecoinId, supplyHistory(active.startedAt)]]),
    mintBurnHourlyByCoin: new Map(),
    dewsByCoin: new Map(),
    liqByCoin: new Map(),
    liqTvlChange7dByCoin: new Map(),
    liqTvlChange30dByCoin: new Map(),
    liqVolumeChange30dByCoin: new Map(),
    redemptionByCoin: new Map(),
    safetyByCoin: new Map(),
    v9ExitByCoin: new Map(),
    safetyContext: { status: "identity-missing", reason: "test", identity: null },
    lineage: {
      trainingWindow: { start: NOW_SEC - 365 * DAY, end: NOW_SEC },
      eventCount: 0,
      incidentCount: 0,
      coinCount: 0,
      quarantinedCoins: 0,
    },
    ...overrides,
  };
}

export function publishedDewsConfigs(signalsJson = "{}"): MockTableConfig[] {
  const computedAt = NOW_SEC - 60;
  const row = {
    stablecoin_id: "usdc-circle",
    score: 66,
    band: "WARNING",
    signals_json: signalsJson,
    computed_at: computedAt,
  };
  return [
    {
      match: "FROM cache WHERE key = ?",
      matchBinds: ["dews:published-generation"],
      rows: [],
      first: {
        value: JSON.stringify({
          updatedAt: computedAt,
          source: "compute-dews",
          publishStatus: "published",
          coverageVersion: 2,
          expectedRowCount: 1,
          stablecoinIdsDigest: buildDewsStablecoinIdsDigest([row.stablecoin_id]),
        }),
        updated_at: computedAt,
      },
    },
    { match: "pharos:stress-signals:published-exact", rows: [row] },
  ];
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
