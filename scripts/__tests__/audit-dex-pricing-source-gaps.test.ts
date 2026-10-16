import { describe, expect, it } from "vitest";
import {
  buildDexPricingSourceGapAudit,
  renderDexPricingSourceGapMarkdown,
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

const providerSupplyCases: Array<{
  circulating: Record<string, number> | undefined;
  marketCapUsd: number | null;
  rendered: string;
}> = [
  { circulating: undefined, marketCapUsd: null, rendered: "N/A (supply unavailable)" },
  { circulating: {}, marketCapUsd: null, rendered: "N/A (supply unavailable)" },
  { circulating: { peggedUSD: 0 }, marketCapUsd: 0, rendered: "$0" },
];

describe("audit-dex-pricing-source-gaps", () => {
  it.each(providerSupplyCases)(
    "renders provider targeting supply without coercing absence (%j)", ({ circulating, marketCapUsd, rendered }) => {
      const audit = buildDexPricingSourceGapAudit({
        stablecoins: [stablecoinRow({ circulating })],
        dexPrices: [dexPriceRow({ source_total_tvl: 6_000_000 })],
      });
      expect(audit.providerTargetingGaps).toMatchObject([{ marketCapUsd }]);
      expect(renderDexPricingSourceGapMarkdown(audit)).toContain(`| ${rendered} |`);
    },
  );
});
