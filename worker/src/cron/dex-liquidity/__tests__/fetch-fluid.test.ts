import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachFluidSwapStatuses, indexFluidDefiLlamaAliases } from "../fluid-swap-status";
import { makePool } from "./scoring-test-builders";
import { fetchFluidPools } from "../fetch-fluid";
import { initLiquidityFallbackCounters } from "../pool-helpers";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { fetchEvmCallHexAtBlock } from "../../../lib/evm-rpc";
import type * as EvmRpcModule from "../../../lib/evm-rpc";

vi.mock("../../../lib/evm-rpc", async (importOriginal) => {
  const actual = await importOriginal<typeof EvmRpcModule>();
  return { ...actual, fetchEvmCallHexAtBlock: vi.fn() };
});

describe("fetchFluidPools", () => {
  beforeEach(() => {
    vi.mocked(fetchEvmCallHexAtBlock).mockReset().mockResolvedValue(null);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("joins the venue status to an opaque DefiLlama deployment independently of the ticker", async () => {
    const address = "0x97f32e5091d0e6aee24beb398e6592ae111dee9c";
    const uuid = "e3a3baab-c962-525b-a9a7-231325714c8b";
    const tokens = ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xd0580192e98ea6ceb9c7b6191ed2e27560911697"];
    const official = { address, token0Address: tokens[0], token1Address: tokens[1], state: { isSwapAndArbitragePaused: true } };
    const alias = { project: "fluid-dex", chain: "Ethereum", pool: uuid, pool_old: `ethereum-${address}`,
      poolTokenAddress: address, underlyingTokens: tokens };
    const duplicate = { ...official, address: tokens[1] };
    const live = { ...official, address: tokens[0], token1Address: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", state: { isSwapAndArbitragePaused: false } };
    mockFetch([
      { match: "/dexes/stats/tickers", body: [] },
      { match: "/v2/1/dexes", body: [official, live, duplicate, { ...duplicate, state: live.state }] },
      { match: "api.fluid.instadapp.io", body: [] },
      { match: "poolsPro?project=fluid-dex", body: { data: [alias, { ...alias, pool: "native-alias",
        pool_old: `Ethereum-${tokens[0]}`, poolTokenAddress: tokens[0], underlyingTokens: [tokens[0], `0x${"0".repeat(40)}`] }] } },
    ], { requireMatch: true });
    const { fluidSwapStatuses, pools } = await fetchFluidPools(undefined, new Map());
    expect(pools).toEqual([]);
    const build = (id: string, fingerprint?: string) => makePool({ poolId: `ethereum:${id}`, project: "fluid", candidateFingerprint: fingerprint });
    expect(fluidSwapStatuses?.get("ethereum:defillama:native-alias")?.observation.status).toBe("active");
    const fingerprint = `fp:ethereum:fluid:${tokens.join(":")}`;
    const inventory = [build(`defillama:${uuid}`, fingerprint), build(`defillama:${uuid}`, "wrong"), build(address),
      build(tokens[0]!), build(tokens[1]!), build("absent"), build("defillama:native-alias", `fp:ethereum:fluid:${tokens[0]}:${live.token1Address}`)];
    attachFluidSwapStatuses(new Map([["trusd-tori", { stablecoinId: "trusd-tori", symbol: "trUSD", pools: inventory }]]), fluidSwapStatuses);
    expect(inventory.map((pool) => pool.extra?.fluidSwapStatus?.reason)).toEqual([
      "fluid-swaps-paused", "fluid-pool-identity-unverified", "fluid-swaps-paused", "fluid-swaps-active",
      "fluid-swap-state-conflicting", "fluid-swap-state-missing", "fluid-swaps-active",
    ]);
    const ambiguous = new Map(fluidSwapStatuses);
    indexFluidDefiLlamaAliases(ambiguous, { data: [alias, { ...alias, pool: "another-uuid", poolTokenAddress: tokens[1] }] });
    expect(ambiguous.has(`ethereum:defillama:${uuid}`)).toBe(false);
  });

  it.each([
    ["liquidity_in_usd", "100000usd", 0, null, null],
    ["last_price", "1.01usd", 1, null, [0, 20.5]],
    ["base_volume", "10tokens", 1, 1.01, null],
    ["target_volume", "20tokens", 1, 1.01, null],
    ["last_price", " +1.01e0 ", 1, 1.01, [0, 20.5]],
  ] as const)("requires a complete decimal value for %s=%s", async (field, value, poolCount, price, volumes) => {
    const tickerRow = {
      pool_id: "0xabc0000000000000000000000000000000000000",
      base_currency: "0xbase", target_currency: "0xquote",
      liquidity_in_usd: "100000.25", last_price: "1.01",
      base_volume: "0", target_volume: "20.5", [field]: value,
    };
    mockFetch([
      { match: "/v2/1/dexes/stats/tickers", body: [tickerRow] },
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });
    const result = await fetchFluidPools(undefined, new Map());
    expect(result.pools).toHaveLength(poolCount);
    if (poolCount === 1) {
      expect(result.pools[0]).toMatchObject({ tvlUsd: 100000.25, price, tokenVolumes24h: volumes });
    }
  });
  it.each([
    ["collateral-only", [10, 20, 0, 0], null, null, "debt"],
    ["debt-only", null, [0, 0, 30, 40, 0, 0], null, "collateral"],
    ["neither", null, null, null, "collateral and debt"],
    ["complete", [10, 20, 0, 0], [0, 0, 30, 40, 0, 0], [40, 60], null],
    ["zero collateral", [0, 0, 0, 0], [0, 0, 30, 40, 0, 0], [30, 40], null],
    ["zero debt", [10, 20, 0, 0], [0, 0, 0, 0, 0, 0], [10, 20], null],
    ["all zero", [0, 0, 0, 0], [0, 0, 0, 0, 0, 0], [0, 0], null],
  ] as const)("admits only complete reserve captures (%s)", async (_label, collateral, debt, balances, missing) => {
    const encode = (words: readonly number[] | null): `0x${string}` | null =>
      words == null ? null : `0x${words.map((word) => BigInt(word).toString(16).padStart(64, "0")).join("")}`;
    vi.mocked(fetchEvmCallHexAtBlock).mockImplementation(async (_chain, _to, data) =>
      data.startsWith("0x957755e6") ? encode(collateral)
        : data.startsWith("0x55181f11") ? encode(debt) : encode([100]),
    );
    mockFetch([
      { match: "/v2/1/dexes/stats/tickers", body: [{
        pool_id: "0xabc0000000000000000000000000000000000000",
        base_currency: "0xbase", target_currency: "0xquote",
        liquidity_in_usd: "100000", last_price: "1", base_volume: "100", target_volume: "200",
      }] },
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });
    const counters = initLiquidityFallbackCounters();
    const result = await fetchFluidPools(undefined, new Map(), counters);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]).toMatchObject({
      balances, tvlUsd: 100_000, tokenVolumes24h: [100, 200], volume24hUsd: null, feeRate: 0.0001,
    });
    expect(counters.fluidBalancesUnmeasured).toBe(missing == null ? 0 : 1);
    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.errors).toEqual([]);
    if (missing != null) {
      expect(result.warnings).toEqual([expect.stringContaining(`${missing} reserves unavailable`)]);
      expect(result.pools[0]?.balancesNormalized).toBeUndefined();
    } else {
      expect(result.warnings).toEqual([]);
      expect(result.pools[0]?.balancesNormalized).toBe(false);
    }
  });


  it.each([
    // An absent side-volume reading is unmeasured, not a zero: it cannot clear
    // the large-pool guard, so no resolver enrichment is attempted.
    ["skips resolver enrichment for a large pool with unmeasured side volumes", "not-a-number", "200", null, 1, 0, 0],
    // Enrichment was attempted (no RPC configured, so neutral defaults survive).
    ["enriches a large pool whose measured side volumes clear the guard", "90000000", "80000000", [90000000, 80000000], 0, 1, 1],
    ["skips resolver enrichment for a large pool whose measured side volumes are below the guard", "100", "200", [100, 200], 0, 0, 0],
  ] as const)("%s", async (_name, baseVolume, targetVolume, volumes, volumeUnmeasured, feeUnmeasured, balancesUnmeasured) => {
    const tickerRow = {
      pool_id: "0xabc0000000000000000000000000000000000000",
      base_currency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      target_currency: "0xdac17f958d2ee523a2206206994597c13d831ec7",
      base_volume: baseVolume,
      target_volume: targetVolume,
      liquidity_in_usd: "150000000",
      last_price: "1.0001",
    };
    mockFetch([
      { match: "/v2/1/dexes/stats/tickers", body: [tickerRow] },
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });

    const counters = initLiquidityFallbackCounters();
    const result = await fetchFluidPools(undefined, new Map(), counters);
    expect(result.pools).toHaveLength(1);
    expect(result.pools[0]!.tokenVolumes24h).toEqual(volumes);
    expect(counters.fluidVolumeUnmeasured).toBe(volumeUnmeasured);
    expect(counters.fluidFeeRateUnmeasured).toBe(feeUnmeasured);
    expect(counters.fluidBalancesUnmeasured).toBe(balancesUnmeasured);
  });

  it("fails an over-cap chain as that chain's error instead of parsing a truncated ticker list", async () => {
    const tickerRow = {
      pool_id: "0xabc0000000000000000000000000000000000000",
      base_currency: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      target_currency: "0xdac17f958d2fe523a2206206994597c13d831ec7",
      base_volume: "100",
      target_volume: "200",
      liquidity_in_usd: "50000000",
      last_price: "1.0001",
    };
    const encoder = new TextEncoder();
    const oversizedTickerPage = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        // The valid head would be admitted as a pool if the cap were not enforced.
        controller.enqueue(encoder.encode(`[${JSON.stringify(tickerRow)},`));
        controller.enqueue(encoder.encode(" ".repeat(300 * 1024)));
        controller.enqueue(encoder.encode("]"));
        controller.close();
      },
    }), { status: 200 });
    mockFetch([
      { match: "/v2/1/dexes/stats/tickers", respond: oversizedTickerPage },
      { match: "api.fluid.instadapp.io", body: [] },
    ], { requireMatch: true });

    const result = await fetchFluidPools(undefined, new Map());

    // The over-cap chain contributes no pools and names its own error; the other
    // five chains still publish their (empty) results.
    expect(result.pools).toEqual([]);
    expect(result.degraded).toBe(true);
    expect(result.errors).toContain(`fluid ethereum response body exceeded ${256 * 1024} bytes`);
    expect(result.ok).toBe(true);
  });
});
