import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockRegistry } from "../../../../test-helpers/cron";
import { BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC } from "@shared/types/live-reserve-adapter-policy";

const supply = vi.fn();
vi.mock("@shared/lib/stablecoins/registry", () => mockRegistry({ stablecoins: [{
  id: "jltxx-jpmorgan", name: "JPMorgan OnChain Liquidity-Token Money Market Fund", symbol: "JLTXX",
  geckoId: "jpmorgan-onchain-liquidity-token-money-market-fund", detailProvider: "coingecko",
  flags: { backing: "rwa-backed", governance: "centralized", pegCurrency: "USD", navToken: true, yieldBearing: true, rwa: true },
  contracts: [{ chain: "ethereum", address: "0x09864f52b035ae22ee739dfa5c748fa080d07bd8", decimals: 2 }],
  liveReservesConfig: { adapter: "jpmorgan-nav", version: 1, semantics: "single-asset", inputs: { primary: { kind: "http-html", url: "https://am.jpmorgan.com" } } },
}] }));
vi.mock("../../../../lib/fetch-retry", () => ({
  fetchTextWithRetry: async () => ({ response: new Response('{}'), body: '{"coins":{}}' }),
}));
vi.mock("../../../reserve-adapters/helpers", () => ({ probeTrackedTokenSupply: (...args: unknown[]) => supply(...args) }));
vi.mock("../../../../lib/authoritative-price-sources", () => ({ resolveVaultNavSupplyPrice: vi.fn().mockResolvedValue(null) }));

import { fetchFiatCoinGeckoTokens } from "../fiat-cg";
import * as structuredLog from "../../../../lib/structured-log";

const withheldLog = vi.spyOn(structuredLog, "logWorkerEvent");

function snapshotDb(metadata: unknown, source = "jpmorgan-nav"): D1Database {
  const now = Math.floor(Date.now() / 1000);
  const statement = { bind: () => statement, first: async () => ({ source, fetched_at: now, metadata: JSON.stringify(metadata) }) };
  return { prepare: () => statement } as unknown as D1Database;
}

function classSnapshot(classAssetsUsd: number, sourceTimestamp = Math.floor(Date.now() / 1000 / 86400) * 86400) {
  return {
    navPerToken: 1, sourceTimestamp, freshnessMode: "verified",
    details: {
      cusip: "46655R119", shareClassNumber: "4397", ticker: "JLTXX", classAssetsUsd,
      dealingDate: new Date(sourceTimestamp * 1000).toISOString().slice(0, 10),
    },
  };
}

describe("NAV telemetry supply admission without a previous cache row", () => {
  beforeEach(() => {
    supply.mockReset().mockResolvedValue(62_671_284_229n);
    withheldLog.mockClear();
  });

  it("values two-decimal native shares at observed NAV, without fabricating a market quote", async () => {
    const rows = await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined,
      snapshotDb({ ...classSnapshot(626_712_842.29 * 0.9973), navPerToken: 0.9973 }));
    expect(rows).toEqual([expect.objectContaining({
      id: "jltxx-jpmorgan", price: null, supplySource: "onchain-total-supply",
      circulating: { peggedUSD: 626_712_842.29 * 0.9973 },
      chainCirculating: { Ethereum: { chainId: "ethereum", current: 626_712_842.29 * 0.9973 } },
    })]);
  });

  it("withholds a funded missing native leg instead of publishing a partial class", async () => {
    supply.mockResolvedValue(60_000_000_000n);
    expect(await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined,
      snapshotDb(classSnapshot(700_000_000)))).toEqual([]);
    expect(withheldLog).toHaveBeenCalledWith(expect.objectContaining({
      event: "reserve-nav-supply-withheld",
      metadata: expect.objectContaining({ rule: "R4", reason: "class-assets-supply-divergence" }),
    }));
  });

  it("admits a rounded class total within the reviewed tolerance", async () => {
    supply.mockResolvedValue(60_000_000_000n);
    const rows = await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined,
      snapshotDb(classSnapshot(602_000_000)));
    expect(rows[0]).toMatchObject({ circulating: { peggedUSD: 600_000_000 }, supplySource: "onchain-total-supply" });
  });

  it("withholds missing class assets even when NAV is fresh", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined,
      snapshotDb({ navPerToken: 1, sourceTimestamp: now }))).toEqual([]);
    expect(withheldLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ rule: "R4", reason: "class-assets-unavailable" }),
    }));
  });

  it("does not bypass the NAV scope check when a market quote is present", async () => {
    supply.mockResolvedValue(60_000_000_000n);
    const cg = { "jpmorgan-onchain-liquidity-token-money-market-fund": { usd: 1.2, last_updated_at: Math.floor(Date.now() / 1000) } };
    expect(await fetchFiatCoinGeckoTokens(cg, undefined, undefined, undefined,
      snapshotDb(classSnapshot(700_000_000)))).toEqual([]);
    const admitted = await fetchFiatCoinGeckoTokens(cg, undefined, undefined, undefined,
      snapshotDb(classSnapshot(600_000_000)));
    expect(admitted[0]).toMatchObject({ circulating: { peggedUSD: 720_000_000 }, price: 1.2 });
  });

  it.each([null, { navPerToken: 1 }, { navPerToken: 0, sourceTimestamp: 1 }])("withholds admission when NAV is unavailable (%s)", async (metadata) => {
    expect(await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined, snapshotDb(metadata))).toEqual([]);
  });

  it("withholds stale issuer NAV even if a fresh fetch repeats it", async () => {
    const staleDate = Math.floor(Date.now() / 1000 / 86400) * 86400 - BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC - 86400;
    expect(await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined,
      snapshotDb(classSnapshot(626_712_842.29, staleDate)))).toEqual([]);
    expect(withheldLog).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ reason: "class-assets-unavailable" }),
    }));
  });

  it("requires positive readable on-chain supply despite a valid NAV", async () => {
    supply.mockResolvedValue(null);
    expect(await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined,
      snapshotDb(classSnapshot(626_712_842.29)))).toEqual([]);
  });
});
