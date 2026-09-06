import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDexPricingSourceGapAudit,
  parseCliArgs,
  renderDexPricingSourceGapMarkdown,
  runCli,
  type CurvePoolCandidate,
  type DexGapDexPriceRow,
  type DexGapStablecoinRow,
} from "../maintenance/audit-dex-pricing-source-gaps";

function dexPriceRow(overrides: Partial<DexGapDexPriceRow>): DexGapDexPriceRow {
  return {
    stablecoin_id: "test-usd",
    dex_price_usd: 1,
    source_pool_count: 1,
    source_total_tvl: 1_000_000,
    price_sources_json: JSON.stringify([
      { protocol: "curve", chain: "ethereum", price: 1, tvl: 1_000_000, updatedAt: 1_700_000_000 },
    ]),
    updated_at: 1_700_000_000,
    ...overrides,
  };
}

function stablecoinRow(overrides: Partial<DexGapStablecoinRow>): DexGapStablecoinRow {
  return {
    id: "test-usd",
    symbol: "TUSD",
    price: 1,
    priceSource: "coingecko",
    consensusSources: ["coingecko"],
    agreeSources: ["coingecko"],
    circulating: { peggedUSD: 10_000_000 },
    contracts: [{ chain: "ethereum", address: "0x0000000000000000000000000000000000000001" }],
    ...overrides,
  };
}

describe("audit-dex-pricing-source-gaps", () => {
  it.each([
    {
      argv: ["--price-depth", "price-depth.json", "--dex-prices", "dex-prices.json"],
      expected: { priceDepthPath: "price-depth.json", dexPricesPath: "dex-prices.json", format: "markdown" },
    },
    {
      argv: [
        "--stablecoins", "stablecoins.json", "--dex-prices", "dex-prices.json", "--dex-liquidity", "liquidity.json",
        "--curve-candidates", "curve.json", "--json", "--markdown", "--report", "reports/gaps.md",
        "--generated-at", "2026-08-29T00:00:00.000Z",
      ],
      expected: {
        stablecoinsPath: "stablecoins.json",
        dexPricesPath: "dex-prices.json",
        dexLiquidityPath: "liquidity.json",
        curveCandidatesPath: "curve.json",
        format: "markdown",
        reportPath: "reports/gaps.md",
        generatedAt: "2026-08-29T00:00:00.000Z",
      },
    },
    {
      argv: ["--future-flag", "legacy-value", "--json"],
      expected: { format: "json", stablecoinsPath: null, dexPricesPath: null },
    },
  ])("accepts legacy option combination %#", ({ argv, expected }) => {
    expect(parseCliArgs(argv)).toMatchObject(expected);
  });

  it("keeps unknown-flag tolerance and missing-value behavior", () => {
    expect(parseCliArgs(["--dex-prices"])).toMatchObject({ dexPricesPath: null });
    expect(parseCliArgs(["--report"])).toMatchObject({ reportPath: null });
    expect(parseCliArgs(["--generated-at"])).toMatchObject({ generatedAt: null });
  });

  it("routes JSON output through the shared runner byte-for-byte", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "dex-pricing-source-gaps-"));
    const stablecoins = [stablecoinRow({})];
    const dexPrices = [dexPriceRow({})];
    writeFileSync(join(cwd, "stablecoins.json"), JSON.stringify(stablecoins), "utf8");
    writeFileSync(join(cwd, "dex-prices.json"), JSON.stringify(dexPrices), "utf8");
    const generatedAt = "2026-08-29T00:00:00.000Z";
    const expectedAudit = buildDexPricingSourceGapAudit({
      stablecoins,
      dexPrices,
      dexLiquidity: [],
      curveCandidates: [],
      generatedAt,
    });
    const outputPath = join(cwd, "reports/gaps.json");

    await expect(
      runCli(["--stablecoins", "stablecoins.json", "--dex-prices", "dex-prices.json", "--json", "--generated-at", generatedAt, "--report", "reports/gaps.json"], cwd),
    ).resolves.toBe(0);

    expect(readFileSync(outputPath, "utf8")).toBe(`${JSON.stringify(expectedAudit, null, 2)}\n`);
  });

  it("derives configured Curve ids from the runtime registry import", () => {
    const audit = buildDexPricingSourceGapAudit({
      generatedAt: "2026-09-06T00:00:00.000Z",
      stablecoins: [],
      dexPrices: [],
      curveCandidates: [
        {
          stablecoinId: "usdt-tether", // configured by shared/lib/curve-pool-configs.ts
          poolAddress: "0x0000000000000000000000000000000000000001",
          chain: "ethereum",
          tvlUsd: 8_000_000,
          inputIndex: 1,
          outputIndex: 2,
          inputDecimals: 6,
          outputDecimals: 6,
          referenceSymbol: "USDC",
          routeType: "direct",
        },
        {
          stablecoinId: "mystery-usd",
          poolAddress: "0x0000000000000000000000000000000000000003",
          chain: "ethereum",
          tvlUsd: 8_000_000,
          inputIndex: 1,
          outputIndex: 2,
          inputDecimals: 6,
          outputDecimals: 6,
          referenceSymbol: "USDC",
          routeType: "direct",
        },
      ],
    });

    expect(audit.curveConfigGaps.map((row) => row.stablecoinId)).toEqual(["mystery-usd"]);
  });

  it("reports material protocol rows whose DEX source key is missing from the registry", () => {
    const audit = buildDexPricingSourceGapAudit({
      generatedAt: "2026-05-24T00:00:00.000Z",
      stablecoins: [stablecoinRow({ id: "usdc-circle", symbol: "USDC", consensusSources: ["coingecko", "curve-dex"] })],
      dexPrices: [
        dexPriceRow({
          stablecoin_id: "usdc-circle",
          source_total_tvl: 10_000_000,
          price_sources_json: JSON.stringify([
            { protocol: "unknownswap", chain: "ethereum", price: 1, tvl: 7_000_000, updatedAt: 1_700_000_000 },
          ]),
        }),
      ],
    });

    expect(audit.registryGaps).toMatchObject([
      {
        stablecoinId: "usdc-circle",
        protocol: "unknownswap",
        sourceKey: "unknownswap-dex",
        protocolTvlUsd: 7_000_000,
      },
    ]);
  });

  it("flags aggregate-suppression candidates when one mapped protocol lane is absent from primary sources", () => {
    const audit = buildDexPricingSourceGapAudit({
      stablecoins: [stablecoinRow({ consensusSources: ["coingecko", "defillama-list"] })],
      dexPrices: [dexPriceRow({ source_total_tvl: 6_000_000 })],
    });

    expect(audit.dexAdmissionGaps).toMatchObject([
      {
        stablecoinId: "test-usd",
        suspectedReason: "aggregate-suppressed-by-rejected-protocol",
        dexTvlUsd: 6_000_000,
      },
    ]);
  });

  it("does not report configured Curve candidates and reports unconfigured material candidates", () => {
    const candidates: CurvePoolCandidate[] = [
      {
        stablecoinId: "configured-usd",
        poolAddress: "0x0000000000000000000000000000000000000001",
        chain: "ethereum",
        tvlUsd: 20_000_000,
        inputIndex: 0,
        outputIndex: 1,
        inputDecimals: 6,
        outputDecimals: 18,
        referenceSymbol: "USDC",
        routeType: "direct",
      },
      {
        stablecoinId: "missing-usd",
        poolAddress: "0x0000000000000000000000000000000000000002",
        chain: "ethereum",
        tvlUsd: 3_000_000,
        inputIndex: 1,
        outputIndex: 0,
        inputDecimals: 6,
        outputDecimals: 18,
        referenceSymbol: "USDC",
        routeType: "direct",
      },
    ];

    const audit = buildDexPricingSourceGapAudit({
      stablecoins: [],
      dexPrices: [],
      curveCandidates: candidates,
      configuredCurveStablecoinIds: new Set(["configured-usd"]),
    });

    expect(audit.curveConfigGaps.map((row) => row.stablecoinId)).toEqual(["missing-usd"]);
    expect(audit.curveConfigGaps[0]).toMatchObject({ priority: "P1", configured: false });
  });

  it("flags low-depth exact-address assets with material DEX TVL as provider targeting gaps", () => {
    const audit = buildDexPricingSourceGapAudit({
      stablecoins: [
        stablecoinRow({
          id: "target-usd",
          symbol: "TGT",
          consensusSources: ["coingecko", "defillama-list"],
          circulating: { peggedUSD: 75_000_000 },
        }),
      ],
      dexPrices: [dexPriceRow({ stablecoin_id: "target-usd", source_total_tvl: 750_000 })],
    });

    expect(audit.providerTargetingGaps).toMatchObject([
      {
        stablecoinId: "target-usd",
        reason: "low-depth-exact-address-material-dex",
        sourceDepth: 2,
        marketCapUsd: 75_000_000,
      },
    ]);
  });

  it("renders markdown sections for implementation review", () => {
    const audit = buildDexPricingSourceGapAudit({
      generatedAt: "2026-05-24T00:00:00.000Z",
      stablecoins: [stablecoinRow({ consensusSources: ["coingecko"] })],
      dexPrices: [dexPriceRow({ source_total_tvl: 6_000_000 })],
    });

    expect(renderDexPricingSourceGapMarkdown(audit)).toContain("## DEX Admission Gaps");
  });
});
