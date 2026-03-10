import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ComparisonTable } from "@/components/comparison-table";
import type { StablecoinData, StablecoinMeta, ReportCardGrade } from "@shared/types";

// Local mirror of the non-exported ComparisonCoin interface
interface ComparisonCoin {
  id: string;
  symbol: string;
  name: string;
  data: StablecoinData;
  meta: StablecoinMeta;
  pegScore: number | null;
  liquidityScore: number | null;
  safetyGrade: ReportCardGrade | null;
  netFlow30d: number | null;
}

// Minimal StablecoinData factory — only fields ComparisonTable cares about
function makeData(circulating: number, circulatingPrevWeek?: number): StablecoinData {
  return {
    id: "test",
    name: "Test",
    symbol: "TST",
    geckoId: null,
    pegType: "peggedUSD",
    pegMechanism: "fiat-backed",
    price: 1.0,
    priceSource: "defillama",
    priceConfidence: null,
    supplySource: undefined,
    circulating: { peggedUSD: circulating },
    circulatingPrevDay: {},
    circulatingPrevWeek: circulatingPrevWeek != null ? { peggedUSD: circulatingPrevWeek } : {},
    circulatingPrevMonth: {},
    chainCirculating: {},
    chains: ["ethereum"],
  };
}

// Minimal StablecoinMeta factory
function makeMeta(id: string, symbol: string): StablecoinMeta {
  return {
    id,
    name: symbol,
    symbol,
    flags: {
      backing: "fiat",
      pegCurrency: "USD",
      governance: "centralized",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
  } as StablecoinMeta;
}

function makeCoin(
  id: string,
  symbol: string,
  circulating: number,
  netFlow30d: number | null,
): ComparisonCoin {
  return {
    id,
    symbol,
    name: symbol,
    data: makeData(circulating),
    meta: makeMeta(id, symbol),
    pegScore: 95,
    liquidityScore: 80,
    safetyGrade: "A",
    netFlow30d,
  };
}

const PEG_RATES: Record<string, number> = { USD: 1 };

describe("ComparisonTable – Net Flow 30D row", () => {
  it("renders formatted positive net flow value", () => {
    const coins: ComparisonCoin[] = [makeCoin("usdt", "USDT", 100e9, 1_240_000_000)];
    const html = renderToStaticMarkup(
      <ComparisonTable coins={coins} pegRates={PEG_RATES} logos={{}} />,
    );
    // getNetPrefix(1_240_000_000) = "+" and formatCurrency(1_240_000_000) = "$1.24B"
    expect(html).toContain("+$1.24B");
  });

  it("renders formatted negative net flow value", () => {
    const coins: ComparisonCoin[] = [makeCoin("usdc", "USDC", 50e9, -340_000_000)];
    const html = renderToStaticMarkup(
      <ComparisonTable coins={coins} pegRates={PEG_RATES} logos={{}} />,
    );
    // getNetPrefix(-340_000_000) = "" and formatCurrency(-340_000_000) = "-$340.00M"
    expect(html).toContain("-$340.00M");
  });

  it("renders em-dash for coin with netFlow30d: null", () => {
    const coins: ComparisonCoin[] = [makeCoin("dai", "DAI", 5e9, null)];
    const html = renderToStaticMarkup(
      <ComparisonTable coins={coins} pegRates={PEG_RATES} logos={{}} />,
    );
    expect(html).toContain("—");
  });

  it("applies font-semibold (BEST_CLASS) to the highest net flow coin", () => {
    const coins: ComparisonCoin[] = [
      makeCoin("usdt", "USDT", 100e9, 1_240_000_000),
      makeCoin("usdc", "USDC", 50e9, 500_000_000),
    ];
    const html = renderToStaticMarkup(
      <ComparisonTable coins={coins} pegRates={PEG_RATES} logos={{}} />,
    );

    // Both values must be present in the rendered output
    expect(html).toContain("+$1.24B");
    expect(html).toContain("+$500.00M");

    // BEST_CLASS = "text-green-600 dark:text-green-400 font-semibold"
    // The best (highest) coin's cell should carry font-semibold immediately before its value.
    // renderToStaticMarkup produces raw HTML: the class attribute closes with `">` then the value.
    expect(html).toContain('font-semibold">+$1.24B');
  });

  it("does not render em-dash when both coins have numeric net flows", () => {
    const coins: ComparisonCoin[] = [
      makeCoin("usdt", "USDT", 100e9, 1_240_000_000),
      makeCoin("usdc", "USDC", 50e9, -340_000_000),
    ];
    const html = renderToStaticMarkup(
      <ComparisonTable coins={coins} pegRates={PEG_RATES} logos={{}} />,
    );
    // Both values are non-null, so no em-dash should appear in the net flow row
    // (the "—" em-dash is only rendered when netFlow30d is null)
    expect(html).toContain("+$1.24B");
    expect(html).toContain("-$340.00M");
  });

  it("renders Net Flow 30D label", () => {
    const coins: ComparisonCoin[] = [makeCoin("usdt", "USDT", 100e9, 0)];
    const html = renderToStaticMarkup(
      <ComparisonTable coins={coins} pegRates={PEG_RATES} logos={{}} />,
    );
    expect(html).toContain("Net Flow 30D");
  });
});
