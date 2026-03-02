import { describe, it, expect } from "vitest";
import { categorizeCollateral, computeGroupedExposure } from "@/hooks/use-portfolio";
import type { UpstreamExposure } from "@/hooks/use-portfolio";

describe("categorizeCollateral", () => {
  it("maps T-bill variants to U.S. Treasury Bills", () => {
    expect(categorizeCollateral("Short-term U.S. Treasury bills")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("BlackRock BUIDL (U.S. T-Bills, cash, repos)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("Hashnote USYC (tokenized T-bills/reverse repos)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("Superstate USTB (tokenized T-bills)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("wM / U.S. Treasury Bills (via M0 Protocol)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("Overnight reverse repos (secured by Treasuries)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("OpenEden TBILL tokens (tokenized U.S. T-bills)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("Money market funds (Fidelity / Amundi)")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("U.S. Treasuries")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("Short-Term U.S. Treasuries")).toBe("U.S. Treasury Bills");
    expect(categorizeCollateral("U.S. Government Securities")).toBe("U.S. Treasury Bills");
  });

  it("maps cash deposit variants to USD Cash Deposits", () => {
    expect(categorizeCollateral("Cash deposits (JP Morgan, Lead Bank)")).toBe("USD Cash Deposits");
    expect(categorizeCollateral("USD cash deposits at BNY Mellon (segregated)")).toBe("USD Cash Deposits");
    expect(categorizeCollateral("Cash and cash equivalents")).toBe("USD Cash Deposits");
    expect(categorizeCollateral("Cash")).toBe("USD Cash Deposits");
  });

  it("maps ETH variants to ETH / Liquid Staking", () => {
    expect(categorizeCollateral("ETH (overcollateralized CDP)")).toBe("ETH / Liquid Staking");
    expect(categorizeCollateral("wstETH (Lido)")).toBe("ETH / Liquid Staking");
    expect(categorizeCollateral("WETH (wrapped Ether)")).toBe("ETH / Liquid Staking");
    expect(categorizeCollateral("ETH / wstETH / LsETH")).toBe("ETH / Liquid Staking");
  });

  it("maps BTC variants to Bitcoin (BTC)", () => {
    expect(categorizeCollateral("Bitcoin (BTC) — native and wrapped variants (tBTC, WBTC, SolvBTC, cbBTC)")).toBe("Bitcoin (BTC)");
    expect(categorizeCollateral("WBTC / cbBTC / kBTC (wrapped Bitcoin variants)")).toBe("Bitcoin (BTC)");
    expect(categorizeCollateral("BTC (delta-neutral)")).toBe("Bitcoin (BTC)");
  });

  it("maps perp/delta-neutral variants to Delta-Neutral Positions", () => {
    expect(categorizeCollateral("Delta-neutral ETH basis trade positions (via sUSDe/USDe)")).toBe("Delta-Neutral Positions");
    expect(categorizeCollateral("Perpetual short futures positions (CEX via Ceffu custody)")).toBe("Delta-Neutral Positions");
    expect(categorizeCollateral("Short perp margin (Copper/Ceffu off-exchange)")).toBe("Delta-Neutral Positions");
    expect(categorizeCollateral("BTC-margined perpetual futures (short positions)")).toBe("Delta-Neutral Positions");
    expect(categorizeCollateral("Spot crypto (BTC/ETH, delta-hedged via perp shorts)")).toBe("Delta-Neutral Positions");
  });

  it("maps gold variants to Physical Gold", () => {
    expect(categorizeCollateral("Physical gold bars (LBMA Good Delivery, Brink's London vaults)")).toBe("Physical Gold");
    expect(categorizeCollateral("Physical gold bullion (LBMA-approved, ABX/Brink's/Loomis vaults)")).toBe("Physical Gold");
  });

  it("maps silver to Physical Silver", () => {
    expect(categorizeCollateral("Physical silver bullion (999 fine, ABX global vaults)")).toBe("Physical Silver");
  });

  it("maps EUR/European assets correctly", () => {
    expect(categorizeCollateral("Euro bank deposits (CRR credit institutions, EU)")).toBe("EUR / European Assets");
    expect(categorizeCollateral("EUR bank deposits (Arion Bank, LHV Bank)")).toBe("EUR / European Assets");
    expect(categorizeCollateral("Euro cash and cash equivalents (bank/custody accounts)")).toBe("EUR / European Assets");
    expect(categorizeCollateral("Cash deposits at Tier 1 European banks")).toBe("EUR / European Assets");
  });

  it("maps DeFi positions to DeFi Collateral", () => {
    expect(categorizeCollateral("Morpho vaults (Ethereum, Base, Arbitrum, Unichain)")).toBe("DeFi Collateral");
    expect(categorizeCollateral("Pendle PT/LP positions (leveraged DeFi yield)")).toBe("DeFi Collateral");
    expect(categorizeCollateral("Curve USDC/USDU LP tokens")).toBe("DeFi Collateral");
  });

  it("maps altcoins to Other Crypto", () => {
    expect(categorizeCollateral("Long AVAX spot positions")).toBe("Other Crypto");
    expect(categorizeCollateral("DOT")).toBe("Other Crypto");
    expect(categorizeCollateral("SUI (native token CDPs)")).toBe("Other Crypto");
  });

  it("falls back to Other RWA for unrecognized names", () => {
    expect(categorizeCollateral("U.S. private credit ABS (SMB receivables)")).toBe("Other RWA");
    expect(categorizeCollateral("Asian sovereign bonds (BBB+ min)")).toBe("Other RWA");
    expect(categorizeCollateral("Something completely unknown")).toBe("Other RWA");
  });
});

describe("computeGroupedExposure", () => {
  const totalUsd = 100_000;

  it("collapses multiple T-bill collateral entries into one", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "__collateral_buidl__", name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)", symbol: "BUIDL", usd: 30_000, pct: 30, isCollateral: true },
      { coinId: "__collateral_wm__", name: "wM / U.S. Treasury Bills (via M0 Protocol)", symbol: "wM", usd: 20_000, pct: 20, isCollateral: true },
      { coinId: "__collateral_ustb__", name: "Superstate USTB (tokenized T-bills)", symbol: "USTB", usd: 10_000, pct: 10, isCollateral: true },
    ];
    const grouped = computeGroupedExposure(raw, totalUsd);
    expect(grouped).toHaveLength(1);
    expect(grouped[0].name).toBe("U.S. Treasury Bills");
    expect(grouped[0].usd).toBe(60_000);
    expect(grouped[0].pct).toBeCloseTo(60);
    expect(grouped[0].isCollateral).toBe(true);
  });

  it("passes non-major stablecoin entries (isCollateral: false) through unchanged", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "999", name: "Some Other Stable", symbol: "SOS", usd: 50_000, pct: 50, isCollateral: false },
      { coinId: "__collateral_buidl__", name: "BlackRock BUIDL (U.S. T-Bills, cash, repos)", symbol: "BUIDL", usd: 50_000, pct: 50, isCollateral: true },
    ];
    const grouped = computeGroupedExposure(raw, totalUsd);
    const stableEntry = grouped.find((e) => !e.isCollateral);
    expect(stableEntry?.symbol).toBe("SOS");
    expect(stableEntry?.usd).toBe(50_000);
  });

  it("groups major centralized stablecoin deps into one entry", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "2",   name: "USD Coin", symbol: "USDC", usd: 40_000, pct: 40, isCollateral: false },
      { coinId: "213", name: "M by M0",  symbol: "M",    usd: 20_000, pct: 20, isCollateral: false },
      { coinId: "173", name: "BlackRock USD", symbol: "BUIDL", usd: 10_000, pct: 10, isCollateral: false },
      { coinId: "999", name: "Other Dep", symbol: "OTH",  usd: 30_000, pct: 30, isCollateral: false },
    ];
    const grouped = computeGroupedExposure(raw, totalUsd);
    const major = grouped.find((e) => e.coinId === "__group_major_centralized__");
    expect(major?.name).toBe("Major Centralized Stablecoins");
    expect(major?.usd).toBe(70_000);
    expect(major?.pct).toBeCloseTo(70);
    expect(major?.isCollateral).toBe(false);
    // Non-major dep passes through individually
    const other = grouped.find((e) => e.symbol === "OTH");
    expect(other?.usd).toBe(30_000);
  });

  it("keeps collateral entries from different categories separate", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "__collateral_tbills__", name: "Short-term U.S. Treasury bills", symbol: "T-Bills", usd: 40_000, pct: 40, isCollateral: true },
      { coinId: "__collateral_eth__", name: "wstETH (Lido)", symbol: "wstETH", usd: 60_000, pct: 60, isCollateral: true },
    ];
    const grouped = computeGroupedExposure(raw, totalUsd);
    expect(grouped).toHaveLength(2);
    expect(grouped.map((e) => e.name).sort()).toEqual(["ETH / Liquid Staking", "U.S. Treasury Bills"].sort());
  });

  it("returns entries sorted stablecoins first then collateral descending by usd", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "__c_eth__", name: "ETH (overcollateralized CDP)", symbol: "ETH", usd: 10_000, pct: 10, isCollateral: true },
      { coinId: "2", name: "USD Coin", symbol: "USDC", usd: 40_000, pct: 40, isCollateral: false },
      { coinId: "__c_tbills__", name: "Short-term U.S. Treasury bills", symbol: "T-Bills", usd: 50_000, pct: 50, isCollateral: true },
    ];
    const grouped = computeGroupedExposure(raw, totalUsd);
    expect(grouped[0].isCollateral).toBe(false);
    expect(grouped[1].name).toBe("U.S. Treasury Bills");
    expect(grouped[2].name).toBe("ETH / Liquid Staking");
  });

  it("recalculates pct based on totalUsd", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "__c_t__", name: "Short-term U.S. Treasury bills", symbol: "T-Bills", usd: 25_000, pct: 25, isCollateral: true },
    ];
    const grouped = computeGroupedExposure(raw, 100_000);
    expect(grouped[0].pct).toBeCloseTo(25);
  });

  it("returns empty array for empty input", () => {
    expect(computeGroupedExposure([], 100_000)).toEqual([]);
  });

  it("sets pct to 0 when totalUsd is 0", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "__c_t__", name: "Short-term U.S. Treasury bills", symbol: "T-Bills", usd: 0, pct: 0, isCollateral: true },
    ];
    const grouped = computeGroupedExposure(raw, 0);
    expect(grouped[0].pct).toBe(0);
  });

  it("handles collateral-only input with no stablecoin entries", () => {
    const raw: UpstreamExposure[] = [
      { coinId: "__c_t__", name: "Short-term U.S. Treasury bills", symbol: "T-Bills", usd: 100_000, pct: 100, isCollateral: true },
    ];
    const grouped = computeGroupedExposure(raw, 100_000);
    expect(grouped.every((e) => e.isCollateral)).toBe(true);
  });
});
