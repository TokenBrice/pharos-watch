import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../enrich-prices";
import type * as StablecoinRegistry from "@shared/lib/stablecoins/registry";

const fetchTextWithRetryMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/fetch-retry", () => ({
  fetchTextWithRetry: fetchTextWithRetryMock,
}));

vi.mock("@shared/lib/stablecoins/registry", async (importOriginal) => {
  const actual = await importOriginal<typeof StablecoinRegistry>();
  const ACTIVE_META_BY_ID = new Map(actual.ACTIVE_META_BY_ID);
  const zarm = ACTIVE_META_BY_ID.get("zarm-mento");
  if (!zarm) throw new Error("missing ZARm test metadata");
  ACTIVE_META_BY_ID.set("zarm-mento", { ...zarm, detailProvider: "defillama" });
  return { ...actual, ACTIVE_META_BY_ID };
});

vi.mock("../supplemental-assets/onchain-supply", () => ({
  fetchCuratedAggregateOnChainMcap: vi.fn(),
}));

import {
  prioritizeSupplyGapCandidateOrder,
  reconcileTrackedSupplyGaps,
} from "../supply-gap-reconciliation";
import { fetchCuratedAggregateOnChainMcap } from "../supplemental-assets/onchain-supply";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeAsset(): PeggedAsset {
  return {
    id: "eurcv-societe-generale-forge",
    name: "EUR CoinVertible",
    symbol: "EURCV",
    supplySource: "defillama",
    circulating: { peggedEUR: 100 },
    circulatingPrevDay: { peggedEUR: 90 },
    circulatingPrevWeek: { peggedEUR: 80 },
    circulatingPrevMonth: { peggedEUR: 70 },
    chainCirculating: {
      Ethereum: { current: 60, circulatingPrevDay: 54, circulatingPrevWeek: 48, circulatingPrevMonth: 42 },
      Solana: { current: 30, circulatingPrevDay: 27, circulatingPrevWeek: 24, circulatingPrevMonth: 21 },
      Stellar: { current: 10, circulatingPrevDay: 9, circulatingPrevWeek: 8, circulatingPrevMonth: 7 },
    },
    chains: ["Ethereum", "Solana", "Stellar"],
  };
}

function mockCoinGeckoHistory(points: [number, number][], marketCap = 130): void {
  fetchTextWithRetryMock.mockImplementation((url: string) => ({
    response: { ok: true },
    body: JSON.stringify(url.includes("/simple/price")
      ? { "societe-generale-forge-eurcv": { usd_market_cap: marketCap } }
      : { market_caps: points }),
  }));
}

beforeEach(() => {
  fetchTextWithRetryMock.mockReset();
  vi.mocked(fetchCuratedAggregateOnChainMcap).mockReset();
});

describe("supply-gap reconciliation ordering", () => {
  it("admits blocking zero-supply collapses before the bounded missing-chain tail", () => {
    const candidates = [
      ...Array.from({ length: 15 }, (_, index) => ({
        kind: "missing-chain" as const,
        id: `chain-gap-${index}`,
      })),
      { kind: "zero-supply-collapse" as const, id: "xofm-mento" },
    ];

    const ordered = prioritizeSupplyGapCandidateOrder(candidates);

    expect(ordered[0]).toEqual({ kind: "zero-supply-collapse", id: "xofm-mento" });
    expect(ordered.slice(0, 15).some(({ id }) => id === "xofm-mento")).toBe(true);
  });
});

describe("CoinGecko missing-chain remainder reconciliation", () => {
  it("preserves DefiLlama totals and attributes bucket remainders to one missing chain", async () => {
    const nowMs = Date.now();
    const asset = makeAsset();
    mockCoinGeckoHistory([
      [nowMs - (30 * DAY_MS), 65],
      [nowMs - (7 * DAY_MS), 110],
      [nowMs - DAY_MS, 85],
      [nowMs, 130],
    ]);

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(1);
    expect(asset.supplySource).toBe("defillama");
    expect(asset.circulating).toEqual({ peggedEUR: 100 });
    expect(asset.circulatingPrevDay).toEqual({ peggedEUR: 90 });
    expect(asset.circulatingPrevWeek).toEqual({ peggedEUR: 80 });
    expect(asset.circulatingPrevMonth).toEqual({ peggedEUR: 70 });
    expect(asset.chainCirculating?.["XRP Ledger"]).toEqual({
      current: 30,
      circulatingPrevDay: 0,
      circulatingPrevWeek: 30,
      circulatingPrevMonth: 0,
    });
    expect(result.assets).toEqual([{
      id: asset.id,
      reason: "coingecko-gap-fill",
      fromSource: "defillama",
      toValue: 30,
    }]);
  });

  it("restores zero-supply DefiLlama rows from complete chart history", async () => {
    const nowMs = Date.now();
    const asset: PeggedAsset = {
      id: "tryb-bilira",
      name: "BiLira",
      symbol: "TRYB",
      pegType: "peggedTRY",
      pegMechanism: "fiat-backed",
      supplySource: "defillama",
      circulating: { peggedTRY: 0 },
      circulatingPrevDay: { peggedTRY: 0 },
      circulatingPrevWeek: { peggedTRY: 0 },
      circulatingPrevMonth: { peggedTRY: 0 },
      chainCirculating: {},
      chains: ["BSC", "Ethereum"],
    };
    fetchTextWithRetryMock.mockResolvedValue({
      response: { ok: true },
      body: JSON.stringify([
        { date: Math.floor((nowMs - (30 * DAY_MS)) / 1000), totalCirculatingUSD: { peggedTRY: 14_800_000 } },
        { date: Math.floor((nowMs - (7 * DAY_MS)) / 1000), totalCirculatingUSD: { peggedTRY: 15_100_000 } },
        { date: Math.floor((nowMs - DAY_MS) / 1000), totalCirculatingUSD: { peggedTRY: 15_220_000 } },
        { date: Math.floor(nowMs / 1000), totalCirculatingUSD: { peggedTRY: 15_260_000 } },
      ]),
    });

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(1);
    expect(asset).toMatchObject({
      supplySource: "defillama-history-gap-fill",
      circulating: { peggedTRY: 15_260_000 },
      circulatingPrevDay: { peggedTRY: 15_220_000 },
      circulatingPrevWeek: { peggedTRY: 15_100_000 },
      circulatingPrevMonth: { peggedTRY: 14_800_000 },
    });
    expect(result.assets).toEqual([{
      id: "tryb-bilira",
      reason: "defillama-history-gap-fill",
      fromSource: "defillama",
      toValue: 15_260_000,
    }]);
  });

  it("repairs curated zero-supply Mento rows from on-chain aggregate probes", async () => {
    const makeZeroAsset = (
      id: string,
      name: string,
      symbol: string,
      pegType: string,
      chains: string[],
    ): PeggedAsset => ({
      id,
      name,
      symbol,
      pegType,
      pegMechanism: "crypto-backed",
      supplySource: "defillama",
      circulating: { [pegType]: 0 },
      circulatingPrevDay: { [pegType]: 0 },
      circulatingPrevWeek: { [pegType]: 0 },
      circulatingPrevMonth: { [pegType]: 0 },
      chainCirculating: {},
      chains,
    });
    const assets = [
      makeZeroAsset("cadd-cad-digital", "CAD Digital", "CADD", "peggedCAD", ["Ethereum", "Base"]),
      makeZeroAsset("jpym-mento", "Mento Japanese Yen", "JPYm", "peggedCHF", ["Celo"]),
      makeZeroAsset("zarm-mento", "Mento South African Rand", "ZARm", "peggedZAR", ["Celo"]),
      makeZeroAsset("xofm-mento", "Mento West African CFA Franc", "XOFm", "peggedXOF", ["Celo"]),
    ];
    const onchainById: Record<string, {
      mcap: number;
      supplySource: "onchain-total-supply";
      chainCirculating?: Record<string, number>;
    }> = {
      "cadd-cad-digital": {
        mcap: 387_447.5,
        supplySource: "onchain-total-supply",
        chainCirculating: { Ethereum: 197_574.5, Base: 189_873 },
      },
      "jpym-mento": {
        mcap: 103_627.12712522845,
        supplySource: "onchain-total-supply",
        chainCirculating: { Celo: 103_627.12712522845 },
      },
      "zarm-mento": {
        mcap: 8_598.7022994136,
        supplySource: "onchain-total-supply",
        chainCirculating: { Celo: 8_598.7022994136 },
      },
      "xofm-mento": {
        mcap: 33_000.819008033395,
        supplySource: "onchain-total-supply",
        chainCirculating: { Celo: 33_000.819008033395 },
      },
    };
    vi.mocked(fetchCuratedAggregateOnChainMcap).mockImplementation(async (meta) =>
      onchainById[String(meta.id)] ?? null,
    );
    fetchTextWithRetryMock.mockResolvedValue({
      response: { ok: true },
      body: JSON.stringify([]),
    });

    const result = await reconcileTrackedSupplyGaps(
      assets,
      undefined,
      undefined,
      undefined,
      {
        peggedCAD: 0.73,
        peggedJPY: 0.00628,
        peggedZAR: 0.0608,
        peggedXOF: 0.00172,
      },
    );

    expect(result.totalReconciled).toBe(4);
    expect(
      vi.mocked(fetchCuratedAggregateOnChainMcap).mock.calls.map(([meta, priceUsd]) => [
        String(meta.id),
        priceUsd,
      ]),
    ).toEqual([
      ["cadd-cad-digital", 0.73],
      ["jpym-mento", 0.00628],
      ["zarm-mento", 0.0608],
      ["xofm-mento", 0.00172],
    ]);
    expect(result.assets).toEqual([
      { id: "cadd-cad-digital", reason: "onchain-total-supply", fromSource: "defillama", toValue: 387_447.5 },
      { id: "jpym-mento", reason: "onchain-total-supply", fromSource: "defillama", toValue: 103_627.12712522845 },
      { id: "zarm-mento", reason: "onchain-total-supply", fromSource: "defillama", toValue: 8_598.7022994136 },
      { id: "xofm-mento", reason: "onchain-total-supply", fromSource: "defillama", toValue: 33_000.819008033395 },
    ]);
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    expect(byId.get("cadd-cad-digital")).toMatchObject({
      supplySource: "onchain-total-supply",
      circulating: { peggedCAD: 387_447.5 },
      chainCirculating: {
        Ethereum: { current: 197_574.5 },
        Base: { current: 189_873 },
      },
    });
    expect(byId.get("jpym-mento")).toMatchObject({
      supplySource: "onchain-total-supply",
      circulating: { peggedJPY: 103_627.12712522845 },
    });
    const jpymCirculating = byId.get("jpym-mento")?.circulating;
    expect(jpymCirculating?.peggedCHF).toBeUndefined();
    expect(byId.get("zarm-mento")).toMatchObject({
      supplySource: "onchain-total-supply",
      circulating: { peggedZAR: 8_598.7022994136 },
    });
    expect(byId.get("xofm-mento")).toMatchObject({
      supplySource: "onchain-total-supply",
      circulating: { peggedXOF: 33_000.819008033395 },
      chainCirculating: { Celo: { current: 33_000.819008033395 } },
    });
  });

  it("fails closed when the current CoinGecko history point is stale", async () => {
    const staleNowMs = Date.now() - (3 * DAY_MS);
    const asset = makeAsset();
    const before = structuredClone(asset);
    mockCoinGeckoHistory([
      [Date.now() - (30 * DAY_MS), 65],
      [Date.now() - (7 * DAY_MS), 110],
      [staleNowMs, 130],
    ]);

    const result = await reconcileTrackedSupplyGaps([asset]);

    expect(result.totalReconciled).toBe(0);
    expect(asset).toEqual(before);
  });
});
