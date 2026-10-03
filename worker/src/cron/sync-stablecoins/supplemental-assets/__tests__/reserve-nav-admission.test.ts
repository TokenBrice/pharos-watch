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

function snapshotDb(metadata: unknown, source = "jpmorgan-nav"): D1Database {
  const now = Math.floor(Date.now() / 1000);
  const statement = { bind: () => statement, first: async () => ({ source, fetched_at: now, metadata: JSON.stringify(metadata) }) };
  return { prepare: () => statement } as unknown as D1Database;
}

describe("NAV telemetry supply admission without a previous cache row", () => {
  beforeEach(() => { supply.mockReset().mockResolvedValue(62_671_284_229n); });

  it("values two-decimal native shares at observed NAV, without fabricating a market quote", async () => {
    const now = Math.floor(Date.now() / 1000);
    const rows = await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined,
      snapshotDb({ navPerToken: 0.9973, sourceTimestamp: now - 86400 }));
    expect(rows).toEqual([expect.objectContaining({
      id: "jltxx-jpmorgan", price: null, supplySource: "onchain-total-supply",
      circulating: { peggedUSD: 626_712_842.29 * 0.9973 },
      chainCirculating: { Ethereum: { chainId: "ethereum", current: 626_712_842.29 * 0.9973 } },
    })]);
  });

  it.each([null, { navPerToken: 1 }, { navPerToken: 0, sourceTimestamp: 1 }])("withholds admission when NAV is unavailable (%s)", async (metadata) => {
    expect(await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined, snapshotDb(metadata))).toEqual([]);
  });

  it("withholds stale issuer NAV even if a fresh fetch repeats it", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined,
      snapshotDb({ navPerToken: 1, sourceTimestamp: now - BUSINESS_DAY_NAV_SOURCE_MAX_AGE_SEC - 1 }))).toEqual([]);
  });

  it("requires positive readable on-chain supply despite a valid NAV", async () => {
    const now = Math.floor(Date.now() / 1000);
    supply.mockResolvedValue(null);
    expect(await fetchFiatCoinGeckoTokens({}, undefined, undefined, undefined,
      snapshotDb({ navPerToken: 1, sourceTimestamp: now }))).toEqual([]);
  });
});
