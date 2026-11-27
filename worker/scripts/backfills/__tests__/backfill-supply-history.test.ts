import * as perimeters from "@shared/lib/supply-perimeter-changes";
import { readNativeSupplyCheckpoint, type NativeSupplyHistoryRow } from "../../../src/lib/dews/native-quantity";
import { readJsonResponse } from "../../../src/test-helpers/__shared/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockD1 as baseMockD1 } from "@shared/test-utils/mock-d1";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";
import { makeApiRequest, makeApiUrl, stubCryptoForAuth } from "../../../src/test-helpers/__shared/auth";
import { registerStablecoinParameterContract } from "../../../src/test-helpers/__shared/endpoint-contracts";
import type { ChainRpcConfig } from "../../../src/lib/chain-registry";
import { encodeBalanceOfCallData, TOTAL_SUPPLY_SELECTOR } from "../../../src/lib/evm-selectors";
import { fetchHistoricalFxRates } from "../../../src/lib/backfill-fx";
import { handleSupplyHistory } from "../../../src/api/supply-history";
import { ethereumSupplyRpc, supplyRpcResponse } from "./backfill-supply-history.test-support";

function mockD1(
  tables: Parameters<typeof baseMockD1>[0] = [],
  options: Parameters<typeof baseMockD1>[1] = {},
) {
  return baseMockD1([
    ...tables,
    { match: "UPDATE cache SET value = json_set", rows: [] },
  ], options);
}

type PsiEligibleCoin = (typeof import("@shared/lib/psi-eligible"))["PSI_ELIGIBLE_STABLECOINS"][number];

stubCryptoForAuth();
const fixtures = createLatestSchemaFixtureTracker();
afterEach(() => fixtures.closeAll());

const evmRpcMocks = vi.hoisted(() => ({
  resolveClosestBlockAtOrBeforeTimestamp: vi.fn(),
}));
const psiEligibleMocks = vi.hoisted(() => ({
  stablecoins: [] as PsiEligibleCoin[],
  defaultStablecoins: [] as PsiEligibleCoin[],
  metaById: new Map<string, PsiEligibleCoin>(),
  defaultMetaEntries: [] as Array<[string, PsiEligibleCoin]>,
}));

vi.mock("@shared/lib/psi-eligible", async () => {
  // Vitest hoists this factory before static test imports are initialized.
  const { supplyMetadata } = await import("./backfill-supply-history.test-support");
  const fixtures = supplyMetadata();
  const { PSI_HISTORICAL_ASSETS } = await import("@shared/lib/psi-historical-assets");
  // The ID resolver validates historical-asset membership at import time.
  fixtures.push(...PSI_HISTORICAL_ASSETS);
  psiEligibleMocks.stablecoins.push(...fixtures);
  for (const coin of fixtures) psiEligibleMocks.metaById.set(coin.id, coin);
  psiEligibleMocks.defaultStablecoins.push(...fixtures);
  psiEligibleMocks.defaultMetaEntries.push(...fixtures.map((coin): [string, PsiEligibleCoin] => [coin.id, coin]));
  return {
    PSI_ELIGIBLE_STABLECOINS: psiEligibleMocks.stablecoins,
    PSI_ELIGIBLE_META_BY_ID: psiEligibleMocks.metaById,
  };
});

vi.mock("../../../src/lib/evm-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/evm-rpc")>();
  return {
    ...actual,
    resolveClosestBlockAtOrBeforeTimestamp: evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp,
  };
});

const reqUrl = (input: RequestInfo | URL) =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

const evmRpc = (chainId: string, chainName: string, url: string, explorerUrl: string): Map<string, ChainRpcConfig> =>
  new Map([[chainId, {
    chainId, chainName, type: "evm", explorerUrl,
    endpoints: [{ url, operator: "public", keyed: false, position: "registry", stateHistory: "archive", logsHistory: "full" }],
  }]]);

const insertsOf = (db: ReturnType<typeof mockD1>) => db.getHistory().filter((s) => s.sql.includes("INTO supply_history"));

const defaultPriceSeries = () => ({
  prices: [{ timestamp: 1_700_000_000, price: 1.001 }],
  diagnostics: {
    granularity: "daily" as const, sourcesUsed: ["coingecko" as const], quoteMode: "usd" as const, quoteCurrency: "usd",
    mergeReasons: [], perSourceStats: [], policyAdjustments: [], finalPointCount: 1,
  },
});

vi.mock("../../../src/lib/historical-market-prices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/lib/historical-market-prices")>();
  return { ...actual, fetchMarketBackfillPriceSeries: vi.fn(async () => defaultPriceSeries()) };
});

import { handleBackfillSupplyHistoryTrusted } from "../backfill-supply-history";
import { makeReplayDiagnostics } from "../../../src/api/__tests__/depeg-replay.test-support";
import { fetchMarketBackfillPriceSeries, type PricePoint } from "../../../src/lib/historical-market-prices";

vi.mock("../../../src/lib/backfill-fx", async () => {
  const actual = await vi.importActual<typeof import("../../../src/lib/backfill-fx")>("../../../src/lib/backfill-fx");
  return {
    ...actual,
    fetchHistoricalFxRates: vi.fn(async () => ({})),
    fetchHistoricalSecondaryFxRates: vi.fn(async () => ({})),
  };
});

const writeDb = () => mockD1([{ match: "INTO supply_history", rows: [] }]);
const I_BAL = "INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price) VALUES (?, ?, ?, ?)";
const Q_BAL = "SELECT circulating_usd, price FROM supply_history WHERE stablecoin_id = ? AND snapshot_date = ?";
function backfill(db: D1Database, query: string, options: Pick<Parameters<typeof handleBackfillSupplyHistoryTrusted>[0], "coingeckoApiKey" | "chainRpcs"> = {}) {
  const path = query.startsWith("/") ? query : `/api/backfill-supply-history?${query}`;
  return handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl(path),
    request: makeApiRequest(path, { adminKey: "secret" }), ...options });
}

function formatUint256Hex(value: bigint): string {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function useSingleDeploymentSparkSupplyFixture(): string {
  const source = psiEligibleMocks.defaultMetaEntries.find(([id]) => id === "susdt-spark")?.[1];
  if (!source) throw new Error("Missing susdt-spark source metadata for supply fallback fixture");
  const fixtureId = "fixture-spark-savings-usdt";
  const contracts = source.contracts?.filter((contract) => contract.chain === "ethereum") ?? [];
  if (contracts.length !== 1) throw new Error(`Expected one Ethereum contract in Spark supply fallback fixture, got ${contracts.length}`);
  const fixture = { ...source, id: fixtureId, contracts } as PsiEligibleCoin;
  psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, fixture);
  psiEligibleMocks.metaById.clear();
  psiEligibleMocks.metaById.set(fixtureId, fixture);
  return fixtureId;
}

function useMissingDecimalsHistoricalSupplyFixture(): string {
  const source = psiEligibleMocks.defaultMetaEntries.find(([id]) => id === "autousd-auto-finance")?.[1];
  if (!source) throw new Error("Missing autoUSD source metadata for decimals fixture");
  const contracts = source.contracts?.filter((contract) => contract.chain === "ethereum") ?? [];
  const fixture = { ...source, contracts: contracts.map(({ chain, address }) => ({ chain, address })) } as unknown as PsiEligibleCoin;
  psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, fixture);
  psiEligibleMocks.metaById.clear();
  psiEligibleMocks.metaById.set(source.id, fixture);
  return source.id;
}

describe("handleBackfillSupplyHistory", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, ...psiEligibleMocks.defaultStablecoins);
    psiEligibleMocks.metaById.clear();
    for (const [id, meta] of psiEligibleMocks.defaultMetaEntries) psiEligibleMocks.metaById.set(id, meta);
    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockReset();
    vi.mocked(fetchHistoricalFxRates).mockClear().mockResolvedValue({});
    vi.mocked(fetchMarketBackfillPriceSeries).mockClear().mockResolvedValue(defaultPriceSeries());
  });

  registerStablecoinParameterContract({
    name: "supply history backfill",
    path: "/api/backfill-supply-history",
    invoke: (db, url) => handleBackfillSupplyHistoryTrusted({ db, url, request: makeApiRequest(url.toString(), { adminKey: "secret" }) }),
    cases: [{ kind: "unknown", stablecoin: "not-a-real-id", error: "Stablecoin not found" }],
  });

  it.each([false, true])("values native USD-peg balances at the observed token price (dry run: %s)", async (dryRun) => {
    const date = Math.floor(1_700_000_000 / 86_400) * 86_400;
    const db = mockD1(dryRun
      ? [{ match: "SELECT ? AS snapshot_date WHERE NOT EXISTS", rows: [{ snapshot_date: date }] }]
      : [{ match: "INTO supply_history", rows: [] }]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ price: 1, tokens: [{ date: 1_700_000_000, circulating: { peggedUSD: 125_000_000 } }] }),
    );
    const res = await backfill(db, "stablecoin=usdt-tether&startDay=2023-11-14&endDay=2023-11-15" + (dryRun ? "&dry-run=true" : ""));
    const body = await readJsonResponse<{ coinsProcessed: number; rowsInserted: number; errors?: string[] }>(res, 200);
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(dryRun ? 0 : 1);
    expect(body.errors).toBeUndefined();
    const insertStmt = insertsOf(db)[0];
    if (dryRun) {
      expect(body).toMatchObject({ dryRun: true, candidateRows: 1 });
      expect(insertStmt).toBeUndefined();
    } else expect(insertStmt?.binds).toEqual([
      "usdt-tether",
      Math.floor(1_700_000_000 / 86400) * 86400,
      125_000_000 * 1.001,
      1.001, 125_000_000, 1.001, 1_700_000_000,
      JSON.stringify({ supplySource: "defillama", supplyObservedAt: 1_700_000_000, supplyChainGuard: null }), 1_700_000_000,
    ]);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/stablecoin/1"),
      expect.objectContaining({ headers: expect.objectContaining({ "User-Agent": expect.any(String) }) }),
    );
  });

  function mockSupplyTokens(tokens: object[]) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ tokens }));
  }

  const priceSeries = (prices: PricePoint[], granularity: "daily" | "hourly" = "daily") =>
    ({ prices, diagnostics: { ...makeReplayDiagnostics(1), granularity } });

  it("reads canonical DefiLlama native buckets and uses the alias only for absent buckets", async () => {
    const { db, sqlite } = fixtures.open();
    const observedAt = 1_700_000_000;
    const tokens = [
      { totalCirculating: { peggedUSD: 100 }, totalCirculatingUSD: { peggedUSD: 100 } },
      { totalCirculating: { peggedUSD: 200 } },
      { totalCirculating: { peggedUSD: 300 }, circulating: { peggedUSD: 44 } },
      { totalCirculating: {}, circulating: { peggedUSD: 50 } },
      { totalCirculating: { peggedUSD: -1 }, circulating: { peggedUSD: 60 } },
    ].map((entry, i) => ({ ...entry, date: observedAt + i * 86_400 }));
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValue(priceSeries(tokens.map(({ date }) => ({ timestamp: date, price: 1 }))));
    mockSupplyTokens(tokens);
    await backfill(db, "stablecoin=usdt-tether");
    expect(sqlite.prepare("SELECT circulating_usd, circulating_native FROM supply_history ORDER BY snapshot_date").all())
      .toEqual([100, 200, 300, 50].map((count) => ({ circulating_usd: count, circulating_native: count })));
  });

  it("persists the observed market clock independently of the supply valuation on insert and overwrite", async () => {
    const { db, sqlite } = fixtures.open();
    const at = 1_700_000_000;
    const path = "/api/backfill-supply-history?stablecoin=usdt-tether";
    mockSupplyTokens([{ date: at + 120, totalCirculatingUSD: { peggedUSD: 2e9 } }]);
    for (const [timestamp, price, query] of [[at, 0.98, ""], [at + 60, 0.90, "&overwrite=true"]] as const) {
      vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValue(priceSeries([{ timestamp, price }]));
      await backfill(db, path + query);
      expect(sqlite.prepare("SELECT price, price_observed_at, valuation_observed_at_sec FROM supply_history").get())
        .toEqual({ price, price_observed_at: timestamp, valuation_observed_at_sec: null });
    }
  });

  it("values UST at its depeg price and keeps a dry-run continuation read-only", async () => {
    const { db, sqlite } = fixtures.open();
    const day = Date.UTC(2022, 4, 10) / 1000;
    const observedAt = day - 60;
    const dates = [day, day + 86_400];
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValue(priceSeries([
      { timestamp: observedAt, price: 0.1 },
      { timestamp: day + 3_600, price: 0.09 },
      { timestamp: dates[1]!, price: 0.1 },
    ]));
    mockSupplyTokens(dates.map((date) => ({ date, circulating: { peggedUSD: 1_000_000_000 } })));
    const endpoint = "/api/backfill-supply-history?stablecoin=ust-terra";
    const window = "&startDay=2022-05-10&endDay=2022-05-11&windowDays=1";
    const first = await readJsonResponse<{ continuationCursor: string }>(await backfill(db, endpoint + window + "&dry-run=true"), 200);
    const continued = await backfill(db, `${endpoint}&cursor=${encodeURIComponent(first.continuationCursor)}&dry-run=false`);
    expect(await readJsonResponse(continued, 200)).toMatchObject({ dryRun: true, candidateRows: 1, rowsInserted: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM supply_history").get()).toEqual({ count: 0 });
    await backfill(db, endpoint + window);
    expect(sqlite.prepare(`SELECT circulating_usd, circulating_native, price, valuation_price_usd, valuation_observed_at_sec
      FROM supply_history WHERE stablecoin_id = 'ust-terra'`).get()).toEqual({
      circulating_usd: 100_000_000, circulating_native: 1_000_000_000, price: null, valuation_price_usd: 0.1, valuation_observed_at_sec: observedAt,
    });
  });

  it("inserts only missing days and preserves a cron-owned existing row", async () => {
    const { db, sqlite } = fixtures.open();
    const existingDay = Date.UTC(2026, 9, 28) / 1000;
    const missingDay = existingDay + 86_400;
    sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at, supply_provenance) VALUES (?, ?, ?, ?, ?, ?)")
      .run("usdt-tether", existingDay, 422_000, 1, existingDay + 600, JSON.stringify({ source: "cron" }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      tokens: [{ date: existingDay, totalCirculatingUSD: { peggedUSD: 229_000 } }, { date: missingDay, totalCirculatingUSD: { peggedUSD: 430_000 } }],
    }));
    const path = "/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2026-10-28&endDay=2026-10-29";
    expect(await readJsonResponse(await backfill(db, `${path}&dry-run=true`), 200))
      .toMatchObject({ candidateRows: 1, rowsInserted: 0, rowsSkippedExisting: 1 });
    const res = await backfill(db, path);
    const body = await readJsonResponse<{ rowsInserted: number; rowsSkippedExisting?: number }>(res, 200);
    expect(body.rowsInserted).toBe(1);
    expect(body.rowsSkippedExisting).toBe(1);
    expect(sqlite.prepare("SELECT circulating_usd, price, price_observed_at, supply_provenance FROM supply_history WHERE stablecoin_id = ? AND snapshot_date = ?").get("usdt-tether", existingDay))
      .toEqual({ circulating_usd: 422_000, price: 1, price_observed_at: existingDay + 600, supply_provenance: JSON.stringify({ source: "cron" }) });
    expect(sqlite.prepare("SELECT circulating_usd FROM supply_history WHERE stablecoin_id = ? AND snapshot_date = ?").get("usdt-tether", missingDay))
      .toEqual({ circulating_usd: 430_000 });
  });

  it.each([true, false])("enriches an existing quantity only when the retained valuation matches (%s)", async (match) => {
    const { db, sqlite } = fixtures.open();
    const observedAt = 1_700_000_000;
    const day = Math.floor(observedAt / 86_400) * 86_400;
    sqlite.prepare(`INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at)
      VALUES ('usdt-tether', ?, ?, 1.001, ?)`).run(day, 100 * 1.001, match ? observedAt : observedAt + 1);
    mockSupplyTokens([{ date: observedAt, circulating: { peggedUSD: 100 } }]);
    const path = "/api/backfill-supply-history?stablecoin=usdt-tether&quantity-only=true";
    expect(await readJsonResponse(await backfill(db, `${path}&dry-run=true`), 200))
      .toMatchObject({ candidateRows: match ? 1 : 0, rowsQuantityUpdated: 0 });
    const result = await readJsonResponse(await backfill(db, path), 200);
    expect(result).toMatchObject({ rowsInserted: 0, rowsQuantityUpdated: match ? 1 : 0 });
    expect(sqlite.prepare("SELECT circulating_native, valuation_observed_at_sec, circulating_usd FROM supply_history").get())
      .toEqual({ circulating_native: match ? 100 : null, valuation_observed_at_sec: match ? observedAt : null, circulating_usd: 100 * 1.001 });
    const row = sqlite.prepare("SELECT * FROM supply_history").get() as unknown as NativeSupplyHistoryRow;
    expect(readNativeSupplyCheckpoint(row, observedAt)).toEqual(match ? { quantity: 100, observedAt } : null);
    expect(await readJsonResponse(await backfill(db, path), 200)).toMatchObject({ rowsQuantityUpdated: 0 });
  });

  it("overwrites an existing row only with the explicit overwrite=true opt-in", async () => {
    const { db, sqlite } = fixtures.open();
    const day = Date.UTC(2026, 9, 28) / 1000;
    sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, price_observed_at, supply_provenance) VALUES (?, ?, ?, ?, ?, ?)")
      .run("usdt-tether", day, 422_000, 1, day + 600, JSON.stringify({ source: "cron" }));
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ tokens: [{ date: day, totalCirculatingUSD: { peggedUSD: 229_000 } }] }));
    const res = await backfill(db, "stablecoin=usdt-tether&startDay=2026-10-28&endDay=2026-10-28&overwrite=true");
    const body = await readJsonResponse<{ rowsInserted: number; rowsSkippedExisting?: number }>(res, 200);
    expect(body.rowsInserted).toBe(1);
    expect(body.rowsSkippedExisting).toBeUndefined();
    expect(sqlite.prepare("SELECT circulating_usd, price, price_observed_at, supply_provenance FROM supply_history WHERE stablecoin_id = ? AND snapshot_date = ?").get("usdt-tether", day))
      .toEqual({ circulating_usd: 229_000, price: null, price_observed_at: null, supply_provenance: null });
  });

  it.each([false, true])("persists observed zero, replacing a prior positive row only with overwrite=true (%s)", async (seedPrior) => {
    const { db, sqlite } = fixtures.open();
    const day = Date.UTC(2026, 3, 9) / 1000;
    if (seedPrior) sqlite.prepare(I_BAL).run("usdt-tether", day, 100_000_000, 0.99);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ tokens: [{ date: day, circulating: { peggedUSD: 0 } }] }));
    const res = await backfill(db, "stablecoin=usdt-tether&startDay=2026-04-09&endDay=2026-04-09&overwrite=true");
    expect((await readJsonResponse<{ rowsInserted: number }>(res, 200)).rowsInserted).toBe(1);
    expect(sqlite.prepare(Q_BAL).get("usdt-tether", day))
      .toEqual({ circulating_usd: 0, price: null });
  });

  it("retains USD history when the reported USD bucket is rejected", async () => {
    const { db, sqlite } = fixtures.open();
    const day = Date.UTC(2026, 3, 9) / 1000;
    sqlite.prepare(I_BAL).run("usdt-tether", day, 100_000_000, 1);
    const url = "/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2026-04-09&endDay=2026-04-09&overwrite=true";
    for (const native of [50_000_000, 0]) {
      vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce(priceSeries([{ timestamp: day, price: 1 }], "hourly"));
      mockSupplyTokens([{ date: day, totalCirculatingUSD: { peggedUSD: -1 }, totalCirculating: { peggedUSD: native } }]);
      expect(await readJsonResponse(await backfill(db, url), 200)).toMatchObject({ rowsInserted: 0, skippedDays: 1 });
      expect(sqlite.prepare(Q_BAL).get("usdt-tether", day))
        .toEqual({ circulating_usd: 100_000_000, price: 1 });
    }
  });

  it("stores a rejected native balance with its USD cap and a separate market quote", async () => {
    const { db, sqlite } = fixtures.open();
    const at = 1_700_000_000;
    mockSupplyTokens([{ date: at + 60, totalCirculatingUSD: { peggedUSD: 100_000_000 }, totalCirculating: { peggedUSD: -1 } }]);
    const path = "/api/backfill-supply-history?stablecoin=usdt-tether";
    for (const query of ["", "&overwrite=true"]) {
      expect(await readJsonResponse(await backfill(db, path + query), 200)).toMatchObject({ rowsInserted: 1 });
      expect(sqlite.prepare("SELECT price, price_observed_at, circulating_native FROM supply_history").get())
        .toEqual({ price: null, price_observed_at: null, circulating_native: null });
      const historyUrl = new URL("https://test.invalid/api/supply-history?stablecoin=usdt-tether&range=all");
      expect(await readJsonResponse(await handleSupplyHistory(db, historyUrl, null), 200)).toMatchObject([{
        circulatingUsd: 100_000_000, circulatingNative: null, price: 1.001,
        supplyProvenance: { nativeQuantityUnavailable: true, marketQuote: { price: 1.001, observedAt: at } },
      }]);
    }
  });

  it("keeps a prior positive row when an observed zero arrives without overwrite", async () => {
    const { db, sqlite } = fixtures.open();
    const day = Date.UTC(2026, 3, 9) / 1000;
    sqlite.prepare(I_BAL).run("usdt-tether", day, 100_000_000, 0.99);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ tokens: [{ date: day, circulating: { peggedUSD: 0 } }] }));
    const body = await readJsonResponse<{ rowsInserted: number; rowsSkippedExisting?: number }>(await backfill(db, "stablecoin=usdt-tether&startDay=2026-04-09&endDay=2026-04-09"), 200);
    expect(body).toMatchObject({ rowsInserted: 0, rowsSkippedExisting: 1 });
    expect(sqlite.prepare(Q_BAL).get("usdt-tether", day))
      .toEqual({ circulating_usd: 100_000_000, price: 0.99 });
  });

  it.each([false, true])("persists native non-USD zero without valuation even alongside an unpriceable positive (%s)", async (mixed) => {
    const { db, sqlite } = fixtures.open();
    const day = Date.UTC(2026, 3, 9) / 1000;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      tokens: [{ date: day, circulating: { peggedEUR: 0 } }, ...(mixed ? [{ date: day + 86_400, circulating: { peggedEUR: 100 } }] : [])],
    }));
    const body = await readJsonResponse<{ rowsInserted: number; skippedDays?: number }>(await backfill(db, "stablecoin=euro3-3a-dao&startDay=2026-04-09&endDay=2026-04-10"), 200);
    expect(body.rowsInserted).toBe(1);
    expect(body.skippedDays).toBe(mixed ? 1 : undefined);
    expect(sqlite.prepare("SELECT snapshot_date, circulating_usd, price FROM supply_history WHERE stablecoin_id = ?").all("euro3-3a-dao"))
      .toEqual([{ snapshot_date: day, circulating_usd: 0, price: null }]);
  });

  it.each([undefined, null, {}, { peggedUSD: null }, { peggedUSD: "0" }, { peggedUSD: -1 }, { peggedUSD: 0, other: null }])(
    "withholds absent or malformed buckets without replacing history (%j)", async (circulating) => {
      const { db, sqlite } = fixtures.open();
      const day = Date.UTC(2026, 3, 9) / 1000;
      sqlite.prepare(I_BAL).run("usdt-tether", day, 100, 0.99);
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ tokens: [{ date: day, circulating }] }));
      expect((await readJsonResponse<{ rowsInserted: number }>(await backfill(db, "stablecoin=usdt-tether&startDay=2026-04-09&endDay=2026-04-09"), 200)).rowsInserted).toBe(0);
      expect(sqlite.prepare(Q_BAL).get("usdt-tether", day))
        .toEqual({ circulating_usd: 100, price: 0.99 });
    },
  );

  it("retains prior history when an observed-zero replacement fails during persistence", async () => {
    const { db, sqlite } = fixtures.open();
    const day = Date.UTC(2026, 3, 9) / 1000;
    sqlite.prepare(I_BAL).run("usdt-tether", day, 100, 0.99);
    sqlite.exec("CREATE TRIGGER fail_supply_write AFTER INSERT ON supply_history BEGIN SELECT RAISE(ABORT, 'injected supply write failure'); END");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ tokens: [{ date: day, circulating: { peggedUSD: 0 } }] }));
    await expect(backfill(db, "stablecoin=usdt-tether&startDay=2026-04-09&endDay=2026-04-09&overwrite=true")).rejects.toThrow("injected supply write failure");
    expect(sqlite.prepare(Q_BAL).get("usdt-tether", day))
      .toEqual({ circulating_usd: 100, price: 0.99 });
  });

  it("preserves unbounded history for bare backfill calls", async () => {
    const db = writeDb();
    const oldDay = Math.floor(Date.UTC(2020, 0, 1) / 1000);
    const recentDay = Math.floor(Date.UTC(2026, 0, 1) / 1000);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      price: 1,
      tokens: [
        { date: oldDay, totalCirculatingUSD: { peggedUSD: 10_000_000 } },
        { date: recentDay, totalCirculatingUSD: { peggedUSD: 20_000_000 } },
      ],
    }));
    const res = await backfill(db, "stablecoin=usdt-tether");
    const body = await readJsonResponse<{
      rowsInserted: number; done: boolean; continuationCursor: string | null;
      window: { startDay: number | null; endDay: number | null; requestedStartDay: number | null; requestedEndDay: number | null; windowDays: number | null };
    }>(res, 200);
    expect(body.rowsInserted).toBe(2);
    expect(body.done).toBe(true);
    expect(body.continuationCursor).toBeNull();
    expect(body.window).toEqual({ startDay: null, endDay: null, requestedStartDay: null, requestedEndDay: null, windowDays: null });
    expect(insertsOf(db).map((stmt) => stmt.binds[1])).toEqual([oldDay, recentDay]);
    expect(vi.mocked(fetchMarketBackfillPriceSeries).mock.calls[0]?.[2]?.range).toBeUndefined();
  });

  it.each([undefined, 1])("preserves cursor windows unless explicitly overridden to %s days", async (override) => {
    const day1 = Date.UTC(2026, 0, 1) / 1000;
    const days = Array.from({ length: 5 }, (_, index) => day1 + index * 86_400);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      tokens: days.map((date) => ({ date, totalCirculatingUSD: { peggedUSD: 100_000_000 } })),
    }));
    const db = writeDb();
    let path = "/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2026-01-01&endDay=2026-01-05&windowDays=2";
    const widths: number[] = [];
    for (let page = 0; page < 5; page++) {
      const res = await backfill(db, path);
      const body = await readJsonResponse<{
        rowsInserted: number; done: boolean; continuationCursor: string | null;
        window: { windowDays: number };
      }>(res, 200);
      widths.push(body.rowsInserted);
      expect(body.window.windowDays).toBe(page === 0 ? 2 : override ?? 2);
      if (body.done) {
        expect(body.continuationCursor).toBeNull();
        break;
      }
      expect(body.continuationCursor).toBeTypeOf("string");
      path = `/api/backfill-supply-history?stablecoin=usdt-tether&cursor=${encodeURIComponent(body.continuationCursor!)}`;
      if (page === 0 && override != null) path += `&windowDays=${override}`;
    }
    expect(widths).toEqual(override === 1 ? [2, 1, 1, 1] : [2, 2, 1]);
    expect(insertsOf(db)
      .map((stmt) => stmt.binds[1])).toEqual(days);
  });

  it("threads the request AbortSignal into supply backfill upstream helpers", async () => {
    const db = writeDb();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ price: 1, tokens: [{ date: 1_700_000_000, circulating: { peggedUSD: 125_000_000 } }] }));
    const path = "/api/backfill-supply-history?stablecoin=usdt-tether&startDay=2023-11-14&endDay=2023-11-15";
    const request = makeApiRequest(path, { adminKey: "secret" });
    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl(path), request });
    expect(res.status).toBe(200);
    expect(fetchMarketBackfillPriceSeries).toHaveBeenCalledWith(
      expect.objectContaining({ id: "usdt-tether" }),
      expect.any(String),
      expect.objectContaining({
        signal: request.signal,
        range: { startSec: Math.floor(Date.UTC(2023, 10, 13) / 1000) + 1, endSec: Math.floor(Date.UTC(2023, 10, 16) / 1000) - 1 },
      }),
    );
  });

  it("keeps a benchmark FX rate out of token history even when the native row is unpriceable", async () => {
    const db = writeDb();
    const day = 1_699_920_000;
    vi.mocked(fetchHistoricalFxRates).mockResolvedValue({ EUR: [{ timestamp: day, rate: 1.1 }] });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ tokens: [
      { date: day, circulating: { peggedEUR: 1_000_000 } },
      { date: day + 86_400, totalCirculatingUSD: { peggedEUR: 2_000_000 } },
    ] }));
    const res = await backfill(db, "stablecoin=euro3-3a-dao");
    expect(await readJsonResponse(res, 200)).toMatchObject({ rowsInserted: 1, skippedDays: 1 });
    const inserts = insertsOf(db);
    expect(inserts.map((stmt) => stmt.binds)).toEqual([
      ["euro3-3a-dao", day + 86_400, 2_000_000, null, null, null, null, null, null],
    ]);
    expect(fetchHistoricalFxRates).not.toHaveBeenCalled();
  });

  it("does not clamp sparse non-USD price history outside its covered range", async () => {
    const db = writeDb();
    const beforePriceRange = Math.floor(1_699_913_600 / 86400) * 86400;
    const afterPriceRange = 1_700_000_000 + 86_400;
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValue(priceSeries([{ timestamp: 1_700_000_000, price: 2.5 }]));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      price: 1,
      tokens: [{ date: beforePriceRange, circulating: { peggedEUR: 1_000 } }, { date: afterPriceRange, circulating: { peggedEUR: 2_000 } }],
    }));
    const res = await backfill(db, "stablecoin=eurc-circle&startDay=2023-11-13&endDay=2023-11-15");
    const body = await readJsonResponse<{ coinsProcessed: number; rowsInserted: number; errors?: string[] }>(res, 200);
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors).toBeUndefined();
    expect(insertsOf(db)).toHaveLength(0);
    expect(fetchMarketBackfillPriceSeries).toHaveBeenCalled();
    expect(fetchHistoricalFxRates).not.toHaveBeenCalled();
  });

  it("withholds a non-USD day whose price is an isolated excursion from the surrounding week", async () => {
    const db = writeDb();
    const days = [1_730_505_600, 1_730_592_000, 1_730_678_400, 1_730_764_800, 1_730_851_200]; // 2024-11-02..06
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValue(priceSeries([
      { timestamp: days[0]!, price: 0.169 }, { timestamp: days[1]!, price: 0.169 },
      { timestamp: days[2]!, price: 0.0795 }, { timestamp: days[3]!, price: 0.172 }, { timestamp: days[4]!, price: 0.172 },
    ]));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      price: 1, tokens: days.map((date) => ({ date, circulating: { peggedEUR: 1_000_000 } })),
    }));
    const res = await backfill(db, "stablecoin=eurc-circle&startDay=2024-11-02&endDay=2024-11-06");
    const body = await readJsonResponse<{ coinsProcessed: number; rowsInserted: number; errors?: string[] }>(res, 200);
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(4);
    expect(body.errors).toBeUndefined();
    const inserts = insertsOf(db);
    expect(inserts.find((stmt) => stmt.binds[1] === days[2])).toBeUndefined();
    expect(inserts).toHaveLength(4);
  });

  it("writes program and wrapper observations on their respective sides of the KAU boundary", async () => {
    const { sqlite, db } = fixtures.open();
    const id = "kau-kinesis";
    const source = psiEligibleMocks.metaById.get("susdt-spark")!;
    const meta = { ...source, id, symbol: "KAU", geckoId: "kinesis-gold", detailProvider: "commodity" as const,
      flags: { ...source.flags, pegCurrency: "GOLD" as const } };
    psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, meta);
    psiEligibleMocks.metaById.set(id, meta);
    const start = Date.parse("2026-04-09T00:00:00Z") / 1000;
    const end = start + 86_400;
    vi.spyOn(perimeters, "isKinesisWrapperSupplyCutoverActive").mockImplementation((asset, clock) => asset === id && clock >= end);
    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockImplementation(async (_chain, timestamp, cache) => {
      cache.blockTimestampByNumber.set(500, timestamp);
      return 500;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes("market_chart")) return Response.json({
        prices: [[start * 1000, 80], [end * 1000, 80]], market_caps: [[start * 1000, 5e8], [end * 1000, 5e8]],
      });
      if (url.includes("/coins/")) return Response.json({ market_data: { circulating_supply: 0 } });
      return supplyRpcResponse(init, 500, { [TOTAL_SUPPLY_SELECTOR]: 250_000_000n });
    });
    const result = await backfill(db, `stablecoin=${id}&startDay=2026-04-09&endDay=2026-04-10`, {
      chainRpcs: ethereumSupplyRpc(),
    });
    expect(await readJsonResponse(result, 200)).toMatchObject({ rowsInserted: 2 });
    expect(sqlite.prepare("SELECT circulating_usd, circulating_native FROM supply_history ORDER BY snapshot_date").all())
      .toEqual([{ circulating_usd: 5e8, circulating_native: null }, { circulating_usd: 20000, circulating_native: 250 }]);
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).toHaveBeenCalledTimes(1);
  });

  it("falls back to historical on-chain totalSupply when CoinGecko market caps are all zero", async () => {
    const db = writeDb();
    const fixtureId = useSingleDeploymentSparkSupplyFixture();
    const ts1 = 1_775_692_800_000;
    const ts2 = 1_775_779_200_000;
    const blockNumber = 22_500_000;
    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockImplementation(async (_chain, timestamp) =>
      timestamp < ts2 / 1000 ? blockNumber : blockNumber + 1);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = reqUrl(input);
      if (url.includes("/coins/spark-savings-usdt/market_chart")) return Response.json({ market_caps: [[ts1, 0], [ts2, 0]], prices: [[ts1, 1.0002], [ts2, 1.0011]] });
      if (url.includes("/coins/spark-savings-usdt?")) return Response.json({ market_data: { circulating_supply: 0 } });
      if (url.includes("fake-eth-rpc")) {
        const requestBlock = JSON.parse(String(init?.body)).params[1] as string;
        return requestBlock === `0x${blockNumber.toString(16)}`
          ? supplyRpcResponse(init, blockNumber, { [TOTAL_SUPPLY_SELECTOR]: 1_000_000_000_000n })
          : supplyRpcResponse(init, blockNumber + 1, { [TOTAL_SUPPLY_SELECTOR]: 1_100_000_000_000n });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const res = await backfill(db, `stablecoin=${fixtureId}&startDay=2026-04-09&endDay=2026-04-10`, { coingeckoApiKey: null, chainRpcs: ethereumSupplyRpc() });
    const body = await readJsonResponse<{ coinsProcessed: number; rowsInserted: number; errors?: string[]; skipped?: string[] }>(res, 200);
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(2);
    expect(body.errors).toBeUndefined();
    expect(body.skipped).toBeUndefined();
    const inserts = insertsOf(db);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].binds[0]).toBe(fixtureId);
    expect(inserts[0].binds[2] as number).toBeCloseTo(1_000_200, -1);
    expect(inserts[0].binds[3] as number).toBeCloseTo(1.0002, 4);
    expect(inserts[1].binds[2] as number).toBeCloseTo(1_101_210, -1);
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).toHaveBeenCalledTimes(2);
  });

  it("repairs partial CoinGecko market-cap gaps with historical on-chain totalSupply", async () => {
    const db = writeDb();
    const fixtureId = useSingleDeploymentSparkSupplyFixture();
    const ts1 = 1_775_692_800_000;
    const ts2 = 1_775_779_200_000;
    const blockNumber = 22_500_001;
    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockResolvedValue(blockNumber);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = reqUrl(input);
      if (url.includes("/coins/spark-savings-usdt/market_chart")) return Response.json({ market_caps: [[ts1, 1_234_567], [ts2, 0]], prices: [[ts1, 1.0002], [ts2, 1.0011]] });
      if (url.includes("/coins/spark-savings-usdt?")) return Response.json({ market_data: { circulating_supply: 0 } });
      if (url.includes("fake-eth-rpc")) return supplyRpcResponse(init, blockNumber, { [TOTAL_SUPPLY_SELECTOR]: 1_100_000_000_000n });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const res = await backfill(db, `stablecoin=${fixtureId}&startDay=2026-04-09&endDay=2026-04-10`, { coingeckoApiKey: null, chainRpcs: ethereumSupplyRpc() });
    const body = await readJsonResponse<{ coinsProcessed: number; rowsInserted: number; errors?: string[]; skipped?: string[] }>(res, 200);
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(2);
    expect(body.errors).toBeUndefined();
    expect(body.skipped).toBeUndefined();
    const inserts = insertsOf(db);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].binds).toEqual([fixtureId, Math.floor(ts1 / 1000 / 86_400) * 86_400, 1_234_567, 1.0002, 1_234_567 / 1.0002, 1.0002, ts1 / 1000,
      JSON.stringify({ supplySource: "coingecko", supplyObservedAt: ts1 / 1000, supplyChainGuard: null }), ts1 / 1000]);
    expect(inserts[1].binds[0]).toBe(fixtureId);
    expect(inserts[1].binds[1]).toBe(Math.floor(ts2 / 1000 / 86_400) * 86_400);
    expect(inserts[1].binds[2] as number).toBeCloseTo(1_101_210, -1);
    expect(inserts[1].binds[3] as number).toBeCloseTo(1.0011, 4);
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).toHaveBeenCalledTimes(1);
  });

  it("fails closed instead of replaying one EVM lane for multi-deployment supply fallback", async () => {
    const db = writeDb();
    const ts = 1_775_692_800_000;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = reqUrl(input);
      if (url.includes("/coins/apollo-diversified-credit-securitize-fund/market_chart")) return Response.json({ market_caps: [[ts, 0]], prices: [[ts, 1.01]] });
      if (url.includes("/coins/apollo-diversified-credit-securitize-fund?")) return Response.json({ market_data: { circulating_supply: 0 } });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const chainRpcs = evmRpc("avalanche", "Avalanche", "https://fake-avax-rpc.test", "https://snowtrace.io");
    const res = await backfill(db, "stablecoin=acred-apollo-securitize&startDay=2026-04-09&endDay=2026-04-09", { coingeckoApiKey: null, chainRpcs });
    const body = await readJsonResponse<{ coinsProcessed: number; rowsInserted: number; errors?: string[] }>(res, 200);
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors?.[0]).toContain("unsupported-complete-roster");
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).not.toHaveBeenCalled();
    expect(insertsOf(db)).toHaveLength(0);
  });

  it("rejects an Ethereum plus Solana complete roster when a commodity cap is missing", async () => {
    const fixtureId = useSingleDeploymentSparkSupplyFixture();
    const fixture = psiEligibleMocks.metaById.get(fixtureId)!;
    fixture.contracts = [...fixture.contracts!, { chain: "solana", address: "So11111111111111111111111111111111111111112", decimals: 9 }];
    const ts = Date.parse("2026-04-09T00:00:00Z");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/market_chart")) return Response.json({ market_caps: [[ts, 0]], prices: [[ts, 1.01]] });
      if (url.includes(`/coins/${fixture.geckoId}?`)) return Response.json({ market_data: { circulating_supply: 0 } });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const db = writeDb();
    const body = await readJsonResponse<{ rowsInserted: number; errors?: string[] }>(await backfill(db, `stablecoin=${fixtureId}&startDay=2026-04-09&endDay=2026-04-09`, { chainRpcs: ethereumSupplyRpc() }), 200);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors?.[0]).toContain("unsupported-complete-roster");
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.every(([url]) => !String(url).includes("rpc"))).toBe(true);
    expect(insertsOf(db)).toEqual([]);
  });

  it.each([
    ["matching hourly observations", [[0, 100], [23, 900]], [[0, 1], [23, 3]], 100, 1, 0],
    ["missing first cap", [[23, 900]], [[0, 1], [23, 3]], 900, 3, 23],
    ["missing last price", [[0, 100], [23, 900]], [[0, 1]], 100, 1, 0],
    ["daily observations", [[0, 100]], [[0, 1]], 100, 1, 0],
  ] as const)("pairs exact CoinGecko timestamps for %s", async (_name, caps, prices, cap, price, observedHour) => {
    const fixtureId = useSingleDeploymentSparkSupplyFixture();
    const ts = Date.parse("2026-04-09T00:00:00Z");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/market_chart")) return Response.json({
        market_caps: caps.map(([hour, value]) => [ts + hour * 3_600_000 + 123, value]),
        prices: prices.map(([hour, value]) => [ts + hour * 3_600_000 + 123, value]),
      });
      if (url.includes("/coins/")) return Response.json({ market_data: { circulating_supply: 0 } });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const db = writeDb();
    expect((await readJsonResponse<{ rowsInserted: number }>(await backfill(db, `stablecoin=${fixtureId}&startDay=2026-04-09&endDay=2026-04-09`), 200)).rowsInserted).toBe(1);
    const observedAt = ts / 1000 + observedHour * 3600;
    expect(insertsOf(db).map((stmt) => stmt.binds)).toEqual([[fixtureId, ts / 1000, cap, price, cap / price, price, observedAt,
      JSON.stringify({ supplySource: "coingecko", supplyObservedAt: observedAt, supplyChainGuard: null }), observedAt]]);
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).not.toHaveBeenCalled();
  });

  it("repairs only missing market clocks verified against the source and retained valuation", async () => {
    const { db, sqlite } = fixtures.open();
    const id = useSingleDeploymentSparkSupplyFixture();
    const day = Date.parse("2026-04-09") / 1000;
    const at = day + 30;
    const quoteDays = [0, 1, 2, 3].map((d) => at + d * 86_400);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => String(input).includes("/market_chart")
      ? Response.json({ market_caps: quoteDays.map((t) => [t * 1000, 98e6]), prices: quoteDays.map((t) => [t * 1000, 0.98]) })
      : Response.json({ market_data: { circulating_supply: 1e8 } }));
    const path = `stablecoin=${id}&price-clock-only=true`;
    const seed = sqlite.prepare("INSERT INTO supply_history (stablecoin_id, snapshot_date, circulating_usd, price, valuation_price_usd, valuation_observed_at_sec, price_observed_at) VALUES (?, ?, 98000000, 0.98, ?, ?, ?)");
    seed.run(id, day, 0.98, at, null);
    seed.run(id, day + 86_400, 0.98, at + 86_400 + 1, null);
    seed.run(id, day + 2 * 86_400, 0.99, at + 2 * 86_400, null);
    seed.run(id, day + 3 * 86_400, 0.98, at + 3 * 86_400, at + 3 * 86_400 + 1);
    const read = () => sqlite.prepare("SELECT * FROM supply_history ORDER BY snapshot_date").all();
    const before = read();
    expect(await readJsonResponse(await backfill(db, path + "&dry-run=true"), 200)).toMatchObject({ candidateRows: 1 });
    expect(read()).toEqual(before);
    expect(await readJsonResponse(await backfill(db, path), 200)).toMatchObject({ rowsPriceClockUpdated: 1, rowsInserted: 0 });
    expect(read()).toEqual([{ ...before[0], price_observed_at: at }, ...before.slice(1)]);
    expect(await readJsonResponse(await backfill(db, path), 200)).toMatchObject({ rowsPriceClockUpdated: 0 });
  });

  it("skips historical totalSupply when contract decimals are missing", async () => {
    const db = writeDb();
    const fixtureId = useMissingDecimalsHistoricalSupplyFixture();
    const body = await readJsonResponse<{ rowsInserted: number; errors?: string[] }>(await backfill(db, `stablecoin=${fixtureId}&startDay=2026-06-09&endDay=2026-06-09`), 200);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors?.[0]).toContain("requires contract decimals");
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).not.toHaveBeenCalled();
    expect(db.getHistory()).toHaveLength(0);
  });

  it("backfills USD-valued Base Dollar supply from historical totalSupply without a CoinGecko ID", async () => {
    const db = writeDb();
    const actual = await vi.importActual<typeof import("@shared/lib/stablecoins/registry")>("@shared/lib/stablecoins/registry");
    const baseDollar = actual.TRACKED_META_BY_ID.get("bd-basedollar")!;
    psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, baseDollar);
    psiEligibleMocks.metaById.set(baseDollar.id, baseDollar);
    expect(baseDollar).toMatchObject({
      detailProvider: "defillama",
      llamaId: expect.any(String),
    });
    expect(baseDollar?.geckoId).toBeUndefined();
    // The corrected DefiLlama identity must not disable this allowlisted on-chain
    // totalSupply fixture; no CoinGecko detail request is available for BD.

    const day1 = Math.floor(Date.UTC(2026, 7, 4) / 1000);
    const day2 = Math.floor(Date.UTC(2026, 7, 5) / 1000);
    const totalSupplyByCall = [2_500n * 10n ** 18n, 2_750n * 10n ** 18n];
    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockResolvedValue(49_507_741);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = reqUrl(input);
      if (!url.includes("fake-base-rpc")) throw new Error(`Unexpected fetch: ${url}`);
      const body = JSON.parse(String(init?.body ?? "{}")) as { method?: string; params?: Array<{ data?: string } | string> };
      expect(body.method).toBe("eth_call");
      const call = body.params?.[0];
      expect(typeof call === "object" && call != null ? call.data?.toLowerCase() : undefined).toBe(TOTAL_SUPPLY_SELECTOR);
      const raw = totalSupplyByCall.shift();
      if (raw == null) throw new Error("Unexpected extra Base Dollar totalSupply call");
      return Response.json({ jsonrpc: "2.0", id: 1, result: formatUint256Hex(raw) });
    });
    const chainRpcs = evmRpc("base", "Base", "https://fake-base-rpc.test", "https://base.blockscout.com");
    const res = await backfill(db, "stablecoin=bd-basedollar&startDay=2026-08-04&endDay=2026-08-05", { coingeckoApiKey: null, chainRpcs });
    const body = await readJsonResponse<{ coinsProcessed: number; rowsInserted: number; errors?: string[]; skipped?: string[] }>(res, 200);
    expect(body).toMatchObject({ coinsProcessed: 1, rowsInserted: 2 });
    expect(body.errors).toBeUndefined();
    expect(body.skipped).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(insertsOf(db).map((stmt) => stmt.binds)).toEqual([["bd-basedollar", day1, 2_500, 1], ["bd-basedollar", day2, 2_750, 1]]);
    expect(fetchMarketBackfillPriceSeries).not.toHaveBeenCalled();
  });

  it("skips unpriced historical totalSupply days across a batch", async () => {
    const historicalTotalSupplyCoins = psiEligibleMocks.defaultStablecoins.filter((coin) => ["autousd-auto-finance", "eearn-ember"].includes(coin.id));
    expect(historicalTotalSupplyCoins.map((coin) => coin.id)).toEqual(["autousd-auto-finance", "eearn-ember"]);
    psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, ...historicalTotalSupplyCoins);
    const db = writeDb();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unpriced days must not fetch"));
    const res = await backfill(db, "batch=0&batchSize=2&startDay=2026-06-09&endDay=2026-06-09", { coingeckoApiKey: null, chainRpcs: ethereumSupplyRpc() });
    const body = await readJsonResponse<{ coinsProcessed: number; rowsInserted: number; errors?: string[]; skipped?: string[]; skippedDays?: number }>(res, 200);
    expect(body.coinsProcessed).toBe(2);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors).toHaveLength(2);
    expect(body.skippedDays).toBe(2);
    expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(insertsOf(db)).toHaveLength(0);
  });

  it.each([null, 1.25])("replays USG exclusions only with a historical price (%s)", async (price) => {
    const day = Date.UTC(2026, 4, 9) / 1000;
    const db = writeDb();
    const blockNumber = 24_500_000;
    const source = psiEligibleMocks.metaById.get("usg-tangent")!;
    const pricedFixture = { ...source, geckoId: "fixture-usg" };
    psiEligibleMocks.metaById.set(source.id, pricedFixture);
    psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, pricedFixture);
    vi.mocked(fetchMarketBackfillPriceSeries).mockResolvedValueOnce(priceSeries(price == null ? [] : [{ timestamp: day, price }]));
    evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp.mockResolvedValue(blockNumber);
    const amounts = {
      [TOTAL_SUPPLY_SELECTOR]: 40_020_000n * 10n ** 18n,
      [encodeBalanceOfCallData("0xf89615f75c8161dc185c03020240905f6b66bad9").toLowerCase()]: 19_686_793n * 10n ** 18n,
      [encodeBalanceOfCallData("0x8a7f16508d1e8b48bdf36023f378cc04d9506d4e").toLowerCase()]: 19_780_590n * 10n ** 18n,
    };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => supplyRpcResponse(init, blockNumber, amounts));
    const body = await readJsonResponse<{ rowsInserted: number; skippedDays?: number; errors?: string[] }>(await backfill(db, "stablecoin=usg-tangent&startDay=2026-05-09&endDay=2026-05-09", { coingeckoApiKey: null, chainRpcs: ethereumSupplyRpc() }), 200);
    const inserts = insertsOf(db);
    if (price == null) {
      expect(body.rowsInserted).toBe(0);
      expect(body.skippedDays).toBe(1);
      expect(body.errors?.[0]).toContain("historical on-chain supply backfill wrote 0 rows");
      expect(evmRpcMocks.resolveClosestBlockAtOrBeforeTimestamp).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(inserts).toEqual([]);
    } else {
      expect(body.rowsInserted).toBe(1);
      expect(body.errors).toBeUndefined();
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(inserts.map((stmt) => stmt.binds)).toEqual([["usg-tangent", day, 690_771.25, 1.25, 552_617, 1.25, day, null, day]]);
    }
  });

  it("returns a clear error when CG market caps are all zero and on-chain fallback is unavailable", async () => {
    const ts1 = 1_775_692_800_000;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = reqUrl(input);
      if (url.includes("/coins/spark-savings-usdt/market_chart")) return Response.json({ market_caps: [[ts1, 0]], prices: [[ts1, 1.0]] });
      if (url.includes("/coins/spark-savings-usdt?")) return Response.json({ market_data: { circulating_supply: 0 } });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const res = await backfill(writeDb(), "stablecoin=susdt-spark&startDay=2026-04-09&endDay=2026-04-09", { coingeckoApiKey: null });
    const body = await readJsonResponse<{ coinsProcessed: number; rowsInserted: number; errors?: string[] }>(res, 200);
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors?.[0]).toContain("CoinGecko market caps all zero");
  });

  it.each([
    [undefined, "100", "equivalence unavailable"],
    ["null", "100", "equivalence unavailable"],
    ["0", "100", "equivalence unavailable"],
    ["-1", "100", "equivalence unavailable"],
    ['"100"', "100", "equivalence unavailable"],
    ["1e400", "100", "equivalence unavailable"],
    ["100", "0", "equivalence unavailable"],
    ["100", "-1", "equivalence unavailable"],
    ["100", "1e400", "equivalence unavailable"],
    ["84", "100", "divergence"],
    ["116", "100", "divergence"],
    ["85", "100", null],
    ["100", "100", null],
    ["115", "100", null],
  ])("requires usable in-band TVL equivalence (mcap=%s, latest TVL=%s)", async (mcap, latestTvl, error) => {
    const { db, sqlite } = fixtures.open();
    const day = Date.UTC(2026, 3, 9) / 1000;
    sqlite.prepare(I_BAL)
      .run("xaut-tether", day, 77, 2_000);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/market_chart")) return Response.json({ market_caps: [], prices: [] });
      if (url.includes("/coins/tether-gold?")) return Response.json({ market_data: { circulating_supply: 0 } });
      if (url.includes("/protocol/tether-gold")) {
        // JSON's numeric exponent exercises a non-finite parsed number, not null serialization.
        return new Response(`{${mcap === undefined ? "" : `"mcap":${mcap},`}"tvl":[{"date":${day},"totalLiquidityUSD":50},{"date":${day + 86_400},"totalLiquidityUSD":${latestTvl}}]}`,
          { headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/chart/coingecko:tether-gold")) return Response.json({ coins: {} });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const body = await readJsonResponse<{ rowsInserted: number; errors?: string[] }>(await backfill(db, "stablecoin=xaut-tether&startDay=2026-04-09&endDay=2026-04-09&overwrite=true"), 200);
    expect(body.rowsInserted).toBe(error ? 0 : 1);
    if (error) expect(body.errors?.[0]).toContain(error);
    else expect(body.errors).toBeUndefined();
    expect(sqlite.prepare(Q_BAL).get("xaut-tether", day))
      .toEqual(error ? { circulating_usd: 77, price: 2_000 } : { circulating_usd: 50, price: null });
  });

  it.each([
    { pegCurrency: "USD" as const, protocolSlug: "tether-gold" },
    { pegCurrency: "GOLD" as const, protocolSlug: "multi-token-protocol" },
  ])("rejects protocol TVL without dedicated commodity identity (%j)", async ({ pegCurrency, protocolSlug }) => {
    const source = psiEligibleMocks.metaById.get("xaut-tether")!;
    const fixture = { ...source, flags: { ...source.flags, pegCurrency }, protocolSlug };
    psiEligibleMocks.metaById.set(fixture.id, fixture);
    psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, fixture);
    const { db, sqlite } = fixtures.open();
    const day = Date.UTC(2026, 3, 9) / 1000;
    sqlite.prepare(I_BAL).run(fixture.id, day, 77, 2_000);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).includes("/market_chart")) return Response.json({ market_caps: [], prices: [] });
      if (String(input).includes("/coins/tether-gold?")) return Response.json({ market_data: { circulating_supply: 0 } });
      throw new Error(`Unexpected fallback fetch: ${input}`);
    });
    const body = await readJsonResponse<{ rowsInserted: number; errors?: string[] }>(await backfill(db, "stablecoin=xaut-tether&startDay=2026-04-09&endDay=2026-04-09"), 200);
    expect(body.rowsInserted).toBe(0);
    expect(body.errors?.[0]).toContain("requires a dedicated commodity-token mapping");
    expect(sqlite.prepare(Q_BAL).get(fixture.id, day)).toEqual({ circulating_usd: 77, price: 2_000 });
  });

  it("values TVL only with the latest same-day market observation at or before the checkpoint", async () => {
    const { db, sqlite } = fixtures.open();
    const day1 = Math.floor(Date.UTC(2026, 3, 9) / 1000);
    const day2 = day1 + 86_400;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = reqUrl(input);
      if (url.includes("/coins/tether-gold/market_chart")) return Response.json({ market_caps: [], prices: [] });
      if (url.includes("/coins/tether-gold?")) return Response.json({ market_data: { circulating_supply: 0 } });
      if (url.includes("/protocol/tether-gold")) return Response.json({
        mcap: 101_000_000, tvl: [{ date: day1 + 30, totalLiquidityUSD: 100_000_000 }, { date: day2, totalLiquidityUSD: 101_000_000 }],
      });
      if (url.includes("/chart/coingecko:tether-gold")) return Response.json({
        coins: { "coingecko:tether-gold": { prices: [{ timestamp: day1 + 20, price: 2_300 }, { timestamp: day2 + 1, price: 3_000 }] } },
      });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const res = await backfill(db, "stablecoin=xaut-tether&startDay=2026-04-09&endDay=2026-04-10");
    const body = await readJsonResponse<{ coinsProcessed: number; rowsInserted: number; errors?: string[] }>(res, 200);
    expect(body.coinsProcessed).toBe(1);
    expect(body.rowsInserted).toBe(2);
    expect(body.errors).toBeUndefined();
    expect(sqlite.prepare(
      "SELECT snapshot_date, circulating_usd, price, price_observed_at FROM supply_history WHERE stablecoin_id = ? ORDER BY snapshot_date",
    ).all("xaut-tether")).toEqual([
      { snapshot_date: day1, circulating_usd: 100_000_000, price: 2_300, price_observed_at: day1 + 20 },
      { snapshot_date: day2, circulating_usd: 101_000_000, price: null, price_observed_at: null },
    ]);
  });

  it("consumes the parallel price response before returning a protocol fallback error", async () => {
    const priceResponse = Response.json({ coins: {} });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = reqUrl(input);
      if (url.includes("/coins/tether-gold/market_chart")) return Response.json({ market_caps: [], prices: [] });
      if (url.includes("/coins/tether-gold?")) return Response.json({ market_data: { circulating_supply: 0 } });
      if (url.includes("/protocol/tether-gold")) return Response.json({ tvl: [] });
      if (url.includes("/chart/coingecko:tether-gold")) return priceResponse;
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const res = await backfill(writeDb(), "stablecoin=xaut-tether&startDay=2026-04-09&endDay=2026-04-10");
    const body = await readJsonResponse<{ errors?: string[] }>(res, 200);
    expect(body.errors?.[0]).toContain("no TVL history");
    expect(priceResponse.bodyUsed).toBe(true);
  });

  it("fences DefiLlama and CoinGecko backfill windows at native cutovers while reporting partial failures", async () => {
    const actual = await vi.importActual<typeof import("@shared/lib/stablecoins/registry")>("@shared/lib/stablecoins/registry");
    const jltxx = actual.TRACKED_META_BY_ID.get("jltxx-jpmorgan")!;
    const tbill = actual.TRACKED_META_BY_ID.get("tbill-openeden")!;
    psiEligibleMocks.stablecoins.splice(0, psiEligibleMocks.stablecoins.length, jltxx, tbill);
    psiEligibleMocks.metaById.set(jltxx.id, jltxx);
    psiEligibleMocks.metaById.set(tbill.id, tbill);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-28T12:00:00Z"));
      const day25 = Date.UTC(2026, 10, 25, 12, 0, 0);
      const day26 = Date.UTC(2026, 10, 26, 12, 0, 0);
      const day27 = Date.UTC(2026, 10, 27, 12, 0, 0);
      let recoveredDay26 = false;
      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const u = reqUrl(input);
        if (u.includes("/stablecoin/257")) return Response.json({ tokens: [{ date: day26 / 1000, totalCirculatingUSD: { peggedUSD: 285_000 } }, { date: day27 / 1000, totalCirculatingUSD: { peggedUSD: 290_000 } }, { date: day27 / 1000 + 10_800, totalCirculatingUSD: { peggedUSD: 291_000 } }] });
        if (!u.includes("/market_chart")) return Response.json({ market_data: { circulating_supply: 1_234_567 } });
        return recoveredDay26
          ? Response.json({ prices: [[day25, 1], [day26 - 3_600_000, 1], [day26, 1], [day27, 1]], market_caps: [[day25, 700_000], [day26 - 3_600_000, 0], [day26, 600_000], [day27, 1_234_567]] })
          : Response.json({ prices: [[day25, 1], [day26, 1], [day27, 1]], market_caps: [[day25, 700_000], [day26, 0], [day27, 1_234_567]] });
      });
      const { db, sqlite } = fixtures.open();
      const fenced = await readJsonResponse<Record<string, unknown>>(await backfill(db, "stablecoin=jltxx-jpmorgan&startDay=2026-11-27&endDay=2026-11-27&dry-run=true"), 200);
      expect({ candidateRows: fenced.candidateRows, skippedDays: fenced.skippedDays, errors: fenced.errors }).toEqual({ candidateRows: 0, skippedDays: 1, errors: undefined });
      const mixed = await readJsonResponse<{ candidateRows?: number; skippedDays?: number; errors?: string[] }>(await backfill(db, "stablecoin=jltxx-jpmorgan&startDay=2026-11-26&endDay=2026-11-27&dry-run=true"), 200);
      expect({ candidateRows: mixed.candidateRows, skippedDays: mixed.skippedDays }).toEqual({ candidateRows: 0, skippedDays: 1 });
      expect(mixed.errors?.length).toBe(1);
      const span = await readJsonResponse<{ candidateRows?: number; skippedDays?: number; errors?: string[] }>(await backfill(db, "stablecoin=jltxx-jpmorgan&startDay=2026-11-25&endDay=2026-11-27&dry-run=true"), 200);
      expect({ candidateRows: span.candidateRows, skippedDays: span.skippedDays }).toEqual({ candidateRows: 1, skippedDays: 1 });
      expect(span.errors?.length).toBe(1);
      recoveredDay26 = true;
      const recovered = await readJsonResponse<{ candidateRows?: number; skippedDays?: number; errors?: string[] }>(await backfill(db, "stablecoin=jltxx-jpmorgan&startDay=2026-11-25&endDay=2026-11-27&dry-run=true"), 200);
      expect({ candidateRows: recovered.candidateRows, skippedDays: recovered.skippedDays, errors: recovered.errors }).toEqual({ candidateRows: 2, skippedDays: 1, errors: undefined });
      const dl = await readJsonResponse<{ rowsInserted: number; skippedDays?: number; errors?: string[] }>(await backfill(db, "stablecoin=tbill-openeden&startDay=2026-11-26&endDay=2026-11-27"), 200);
      expect({ rowsInserted: dl.rowsInserted, skippedDays: dl.skippedDays, errors: dl.errors }).toEqual({ rowsInserted: 1, skippedDays: 1, errors: undefined });
      expect(sqlite.prepare("SELECT snapshot_date FROM supply_history WHERE stablecoin_id = ?").all("tbill-openeden"))
        .toEqual([{ snapshot_date: Date.UTC(2026, 10, 26) / 1000 }]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("handleBackfillSupplyHistory shape", () => {
  it("returns 400 with { error } for a malformed startDay query param", async () => {
    const db = mockD1([]);
    const req = makeApiRequest("https://operator.invalid/jobs/backfill-supply-history?startDay=not-a-date", {
      adminKey: "secret",
    });

    const res = await handleBackfillSupplyHistoryTrusted({ db, url: makeApiUrl(req.url), request: req });

    const body = (await readJsonResponse(res, 400)) as { error: string };
    expect(typeof body.error).toBe("string");
  });
});
