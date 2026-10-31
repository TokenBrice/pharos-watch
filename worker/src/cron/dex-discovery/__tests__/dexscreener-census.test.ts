import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/fetch-retry", () => ({
  fetchWithRetry: vi.fn(),
}));

import { fetchWithRetry } from "../../../lib/fetch-retry";
import { fetchDsTokenPairsWithStatus } from "../../../lib/dexscreener";
import { mockCircuitOutcomeRecord } from "../../../test-helpers/cron";
import { crawlDexScreenerPoolsStage, createDexScreenerDiscoveryRunState } from "../crawl-dexscreener-pools";
import { classifyDexDeploymentOutcomes } from "../deployment-outcomes";
import { discoveryContext } from "./discovery.test-support";
import type { DexDeploymentProviderCheck } from "../types";

// Real parser -> crawler -> classifier: only the HTTP transport is mocked.
const DEPLOYMENT = { chain: "base", address: "0x0000000000000000000000000000000000000abc", decimals: 6 };

function pair(overrides: Record<string, unknown> = {}) {
  return {
    chainId: "base", dexId: "aerodrome", pairAddress: "0x00000000000000000000000000000000000000p1",
    labels: [],
    baseToken: { address: DEPLOYMENT.address, name: "Test USD", symbol: "TUSD" },
    quoteToken: { address: "0x0000000000000000000000000000000000000def", name: "USD Coin", symbol: "USDC" },
    priceUsd: "1.00",
    volume: { h24: 15_000, h6: 0, h1: 0, m5: 0 },
    liquidity: { usd: 1, base: 0, quote: 0 },
    pairCreatedAt: null,
    ...overrides,
  };
}

const MILLION = { usd: 1_000_000, base: 500_000, quote: 500_000 };

async function censusFor(rows: unknown[], siblingChecks: DexDeploymentProviderCheck[] = []) {
  vi.mocked(fetchWithRetry).mockResolvedValueOnce(new Response(JSON.stringify(rows)));
  const { value: context } = discoveryContext("test-coin");
  const { providerChecks } = await crawlDexScreenerPoolsStage({
    db: {} as D1Database,
    targets: [[DEPLOYMENT.chain, DEPLOYMENT.address]],
    context,
    runState: createDexScreenerDiscoveryRunState(),
    dependencies: {
      shouldAttemptFetch: vi.fn(async () => true),
      recordOutcome: vi.fn(async () => mockCircuitOutcomeRecord()),
      dsRateLimit: vi.fn(async () => undefined),
      fetchDsTokenPairsWithStatus,
    },
  });
  const [outcome] = classifyDexDeploymentOutcomes({
    stablecoinId: "test-coin", deployments: [DEPLOYMENT], pools: context.pools, nowSec: 1_800_000_000,
    providerChecks: [...siblingChecks, ...providerChecks],
  });
  return { outcome, providerChecks };
}

describe("DexScreener census completeness", () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => vi.mocked(fetchWithRetry).mockReset());

  it.each([
    ["empty pairAddress", pair({ pairAddress: "", liquidity: MILLION })],
    ["missing symbol", pair({ liquidity: MILLION, quoteToken: { address: "0x0000000000000000000000000000000000000def", name: "USD Coin" } })],
  ])("a valid $1 pool beside a $1M %s row loses empty-census authority", async (_name, malformed) => {
    const { outcome, providerChecks } = await censusFor([pair(), malformed]);
    expect(providerChecks).toEqual([expect.objectContaining({ provider: "dexscreener", status: "degraded", observedPoolCount: 0 })]);
    expect(outcome).toMatchObject({ outcome: "provider_inaccessible", observedPoolCount: 0 });
  });

  it("keeps a positive survivor observed beside a rejected row", async () => {
    const { outcome } = await censusFor([pair({ liquidity: MILLION }), pair({ pairAddress: " ", liquidity: MILLION })]);
    expect(outcome).toMatchObject({ outcome: "observed_pools", observedPoolCount: 1 });
  });

  it("degrades an unreadable liquidity reading instead of certifying the pair as a sub-$1K pool", async () => {
    // The parser admits a well-formed pair without a liquidity reading
    // (liquidity: null), so treating it as a measured zero would let an
    // exhaustive DexScreener success certify verified_no_pools.
    const { outcome, providerChecks } = await censusFor([pair({ liquidity: null })]);
    expect(providerChecks).toEqual([
      expect.objectContaining({ provider: "dexscreener", status: "degraded", observedPoolCount: 0 }),
    ]);
    expect(outcome).toMatchObject({ outcome: "provider_inaccessible", observedPoolCount: 0 });
  });

  it.each([
    ["clean empty", []],
    ["low-TVL only", [pair()]],
    ["blocked venue only", [pair({ dexId: "bunni", liquidity: MILLION })]],
  ])("keeps a %s census verified empty", async (_name, rows) => {
    const { outcome } = await censusFor(rows);
    expect(outcome).toMatchObject({ outcome: "verified_no_pools", observedPoolCount: 0 });
  });

  it("lets an independently exhaustive sibling certify empty despite a degraded DexScreener response", async () => {
    const { outcome } = await censusFor([pair(), pair({ pairAddress: "", liquidity: MILLION })], [
      { chain: DEPLOYMENT.chain, address: DEPLOYMENT.address, provider: "coingecko", status: "success", paginationComplete: true },
    ]);
    expect(outcome).toMatchObject({ outcome: "verified_no_pools" });
  });
});
