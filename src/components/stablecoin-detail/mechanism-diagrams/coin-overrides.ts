/**
 * Coin-specific diagram node overrides for up to 8 flagship coins.
 *
 * These allow a label or subtitle on a specific step to be swapped for
 * concrete coin-level copy without creating bespoke per-coin diagrams.
 */

import type { CoinOverride } from "./types";

const COIN_OVERRIDES: Record<string, CoinOverride> = {
  // DAI: CDP with PSM coupling to USDC
  "dai-makerdao": {
    steps: [
      {},
      { label: "Vault + PSM", subtitle: "USDC PSM tightens peg" },
      {},
    ],
  },

  // USDS (Sky): CDP with both USDC and DAI PSMs
  "usds-sky": {
    steps: [
      {},
      { label: "Vault + PSM", subtitle: "USDC and DAI PSMs" },
      {},
    ],
  },

  // GHO (Aave): CDP-style via Aave V3 facilitator with GSM redemption
  "gho-aave": {
    steps: [
      {},
      { label: "Aave V3 facilitator + GSM", subtitle: "USDC/USDT GSMs" },
      {},
    ],
  },

  // USDe (Ethena): delta-neutral with named perp venues
  "usde-ethena": {
    steps: [
      {},
      { subtitle: "perp short on Binance/Bybit/OKX" },
      {},
    ],
  },

  // ftUSD: stablecoin lending with native-asset borrow/stake carry on both chains
  "ftusd-flying-tulip": {
    syntheticStrategy: "borrow-stake",
    steps: [
      { label: "Stablecoin deposit", subtitle: "USDC / USDT / USSD collateral" },
      { label: "Borrow native + stake", subtitle: "WETH / wS into wstETH / stS" },
      { label: "ftUSD base token", subtitle: "carry to sftUSD + protocol" },
    ],
    stressFootnote: "stress: borrow-cost, oracle/liquidation, or withdrawal-buffer shock",
  },

  // crvUSD (Curve): LLAMMA-based continuous rebalancing, no single liquidation threshold
  "crvusd-curve": {
    steps: [
      {},
      { label: "LLAMMA continuous arb", subtitle: "no single-threshold liquidation" },
      {},
    ],
  },

  // LUSD (Liquity v1): ETH-only collateral, 110% MCR, immutable + Stability Pool
  "lusd-liquity": {
    steps: [
      { subtitle: "ETH only, 110% MCR" },
      { subtitle: "immutable code, Stability Pool" },
      {},
    ],
  },

  // BOLD (Liquity v2): multi-collateral branched Stability Pools
  "bold-liquity": {
    steps: [
      { subtitle: "WETH / wstETH / rETH" },
      { subtitle: "branched Stability Pools" },
      {},
    ],
  },

  // USDC (Circle): fiat-cash, BNY Mellon custodian
  "usdc-circle": {
    steps: [
      {},
      { subtitle: "Circle Reserve Fund @ BNY Mellon" },
      {},
    ],
  },
};

/**
 * Returns the coin-specific diagram override for `coinId`, or `undefined`
 * when no override exists for that coin.
 */
export function getCoinOverride(coinId: string): CoinOverride | undefined {
  return COIN_OVERRIDES[coinId];
}
