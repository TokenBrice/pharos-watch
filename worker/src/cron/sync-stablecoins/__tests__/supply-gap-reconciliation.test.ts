import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PeggedAsset } from "../enrich-prices";

const fetchTextWithRetryMock = vi.hoisted(() => vi.fn());

vi.mock("../../../lib/fetch-retry", () => ({
  fetchTextWithRetry: fetchTextWithRetryMock,
}));

vi.mock("../supplemental-assets/onchain-supply", () => ({
  fetchCuratedAggregateOnChainMcap: vi.fn(),
}));

import {
  prioritizeSupplyGapCandidateOrder,
  reconcileTrackedSupplyGaps,
} from "../supply-gap-reconciliation";

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
