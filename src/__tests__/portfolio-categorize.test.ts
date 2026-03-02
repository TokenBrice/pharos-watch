import { describe, it, expect } from "vitest";
import { categorizeCollateral } from "@/hooks/use-portfolio";

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
  });

  it("maps cash deposit variants to USD Cash Deposits", () => {
    expect(categorizeCollateral("Cash deposits (JP Morgan, Lead Bank)")).toBe("USD Cash Deposits");
    expect(categorizeCollateral("USD cash deposits at BNY Mellon (segregated)")).toBe("USD Cash Deposits");
    expect(categorizeCollateral("Cash and cash equivalents")).toBe("USD Cash Deposits");
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
