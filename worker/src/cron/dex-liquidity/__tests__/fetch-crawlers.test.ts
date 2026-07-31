import { describe, expect, it } from "vitest";
import { QUALITY_MULTIPLIERS } from "../../../lib/dex-cron-constants";
import { parseCgPool, classifyCgPool } from "../coingecko-onchain-shared";

function makeCgPool(
  overrides: Partial<{
    dexId: string;
    address: string;
    reserveUsd: string | null;
    volumeUsd24h: string | null;
    baseAddress: string;
    quoteAddress: string;
    basePriceUsd: string | null;
    quotePriceUsd: string | null;
    name: string;
    createdAt: string | null;
    feePct: string | null;
    lockedLiquidityPct: string | null;
  }> = {},
) {
  const attributes = {
    address: overrides.address ?? "0xPool",
    name: overrides.name ?? "USDC / USDT",
    pool_created_at: overrides.createdAt ?? "2025-01-01T00:00:00.000Z",
    base_token_price_usd: overrides.basePriceUsd ?? "1.00",
    quote_token_price_usd: overrides.quotePriceUsd ?? "1.00",
    reserve_in_usd: overrides.reserveUsd ?? "150000",
    volume_usd: { h24: overrides.volumeUsd24h ?? "25000" },
    ...(overrides.feePct !== undefined ? { pool_fee_percentage: overrides.feePct } : {}),
    ...(overrides.lockedLiquidityPct !== undefined
      ? { locked_liquidity_percentage: overrides.lockedLiquidityPct }
      : {}),
  };
  return {
    id: "pool-1",
    type: "pool",
    attributes,
    relationships: {
      base_token: { data: { id: `token_${overrides.baseAddress ?? "0xBase"}`, type: "token" } },
      quote_token: { data: { id: `token_${overrides.quoteAddress ?? "0xQuote"}`, type: "token" } },
      dex: { data: { id: overrides.dexId ?? "uniswap-v3", type: "dex" } },
    },
  };
}

describe("CoinGecko onchain shared helpers", () => {
  it("parses CG pools and classifies fee buckets with locked-liquidity propagation", () => {
    const parsed = parseCgPool(makeCgPool({ feePct: "0.05", lockedLiquidityPct: "37.5" }) as never, "ethereum");

    expect(parsed).not.toBeNull();

    const classified = classifyCgPool(parsed!, {
      pool_fee_percentage: "0.05",
      locked_liquidity_percentage: "37.5",
    });

    expect(parsed).toMatchObject({
      dexId: "uniswap-v3",
      poolAddress: "0xpool",
      tvlUsd: 150000,
      volume24hUsd: 25000,
      baseTokenAddress: "0xbase",
      quoteTokenAddress: "0xquote",
    });
    expect(classified).toMatchObject({
      qualityMultiplier: QUALITY_MULTIPLIERS["uniswap-v3-5bp"],
      poolType: "cg-cl-5bp",
      feePercentage: 0.05,
      lockedLiquidityPct: 37.5,
      balanceRatio: null,
    });
  });

  it("drops CG pools with missing relationship data instead of throwing", () => {
    const malformed = {
      ...makeCgPool(),
      relationships: {
        ...makeCgPool().relationships,
        base_token: { data: null },
      },
    };

    expect(parseCgPool(malformed as never, "ethereum")).toBeNull();
  });

  it("falls back to dex-quality classification when fee data is absent", () => {
    const parsed = parseCgPool(
      makeCgPool({
        dexId: "curve-stable-swap",
        feePct: null,
        basePriceUsd: "1.00",
        quotePriceUsd: "0.99",
      }) as never,
      "ethereum",
    );

    expect(parsed).not.toBeNull();

    const classified = classifyCgPool(parsed!, {
      pool_fee_percentage: null,
      locked_liquidity_percentage: null,
    });

    expect(classified.poolType).toBe("cg-stable-amm");
    expect(classified.qualityMultiplier).toBe(QUALITY_MULTIPLIERS["generic"]);
    expect(classified.feePercentage).toBeNull();
    expect(classified.balanceRatio).toBeNull();
  });

  it("drops invalid numeric fields instead of emitting NaN", () => {
    const parsed = parseCgPool(
      makeCgPool({
        feePct: "not-a-number",
        lockedLiquidityPct: "bad-value",
        basePriceUsd: "1.0",
        quotePriceUsd: "0.3",
      }) as never,
      "ethereum",
    );

    expect(parsed).not.toBeNull();

    const classified = classifyCgPool(parsed!, {
      pool_fee_percentage: "not-a-number",
      locked_liquidity_percentage: "bad-value",
    });

    expect(classified.feePercentage).toBeNull();
    expect(classified.lockedLiquidityPct).toBeNull();
    expect(classified.balanceRatio).toBeNull();
  });

  it("preserves non-EVM pool and token address case while normalizing EVM addresses", () => {
    const raw = makeCgPool({ address: "PoolCase", baseAddress: "MintCase", quoteAddress: "QuoteCase" }) as never;

    expect(parseCgPool(raw, "solana")).toMatchObject({
      poolAddress: "PoolCase",
      baseTokenAddress: "MintCase",
      quoteTokenAddress: "QuoteCase",
    });
    expect(parseCgPool(raw, "ethereum")).toMatchObject({
      poolAddress: "poolcase",
      baseTokenAddress: "mintcase",
      quoteTokenAddress: "quotecase",
    });
  });
});
