import type { PortfolioPreset } from "@/components/portfolio/portfolio-empty-state";

export const PORTFOLIO_PRESETS: readonly PortfolioPreset[] = [
  {
    title: "CeFi Core",
    description: "A major-issuer blend with high liquidity and limited complexity.",
    holdings: [
      { coinId: "usdc-circle", amount: 40 },
      { coinId: "usdt-tether", amount: 35 },
      { coinId: "pyusd-paypal", amount: 25 },
    ],
  },
  {
    title: "Treasury Heavy",
    description: "A mix tilted toward Treasury-backed fixed-par stablecoins and institutional cash reserves.",
    holdings: [
      { coinId: "usdtb-ethena", amount: 30 },
      { coinId: "frxusd-frax", amount: 25 },
      { coinId: "usd0-usual", amount: 25 },
      { coinId: "usdc-circle", amount: 20 },
    ],
  },
  {
    title: "DeFi Native",
    description: "Protocol-issued names with more dependency and collateral nuance.",
    holdings: [
      { coinId: "dai-makerdao", amount: 35 },
      { coinId: "usds-sky", amount: 25 },
      { coinId: "frax-frax", amount: 20 },
      { coinId: "lusd-liquity", amount: 20 },
    ],
  },
  {
    title: "Barbell Mix",
    description: "Core fiat liquidity on one side, higher-yield synthetic exposure on the other.",
    holdings: [
      { coinId: "usdc-circle", amount: 45 },
      { coinId: "usde-ethena", amount: 20 },
      { coinId: "usdtb-ethena", amount: 20 },
      { coinId: "dai-makerdao", amount: 15 },
    ],
  },
];
