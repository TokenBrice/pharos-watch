import type { ReserveSlice, StablecoinMeta } from "./types";

export interface ReserveResult {
  reserves: ReserveSlice[];
  estimated: boolean; // true if using template, false if manually curated
}

// ── Default reserve templates by classification ─────────────────────────

const TEMPLATES: Record<string, ReserveSlice[]> = {
  // Centralized fiat-backed (USDC-like): cash + treasuries + repos
  // Typical: regulated issuer holding short-duration government securities
  "rwa-centralized": [
    { name: "U.S. Treasuries / Gov Securities", pct: 70, risk: "low" },
    { name: "Cash & Bank Deposits", pct: 20, risk: "low" },
    { name: "Other Reserves", pct: 10, risk: "medium" },
  ],

  // CeFi-dependent RWA (FRAX v3-like): mix of treasuries + stablecoin PSM
  "rwa-centralized-dependent": [
    { name: "Tokenized Treasuries / RWA", pct: 50, risk: "low" },
    { name: "Stablecoin Reserves (USDC/USDT)", pct: 35, risk: "medium" },
    { name: "Other Assets", pct: 15, risk: "medium" },
  ],

  // Centralized crypto-backed (rare — Aegis YUSD-like): delta-neutral
  "crypto-centralized": [
    { name: "Stablecoins (USDC/USDT)", pct: 40, risk: "medium" },
    { name: "BTC / ETH Positions", pct: 40, risk: "medium" },
    { name: "Other Crypto", pct: 20, risk: "high" },
  ],

  // CeFi-dependent crypto-backed (DAI-like): crypto CDPs + stablecoin PSM
  "crypto-centralized-dependent": [
    { name: "ETH / LSTs", pct: 35, risk: "medium" },
    { name: "Stablecoin Collateral", pct: 30, risk: "medium" },
    { name: "BTC / wBTC", pct: 15, risk: "medium" },
    { name: "Other Vaults / Assets", pct: 20, risk: "high" },
  ],

  // CeFi-dependent crypto with RWA-quality collateral (DAI/USDS pattern)
  "crypto-centralized-dependent-rwa": [
    { name: "RWA (Treasuries / Tokenized)", pct: 40, risk: "low" },
    { name: "Stablecoin PSM", pct: 30, risk: "medium" },
    { name: "ETH / LSTs", pct: 20, risk: "medium" },
    { name: "Other Vaults", pct: 10, risk: "high" },
  ],

  // CeFi-dependent crypto with exotic collateral (USDe pattern)
  "crypto-centralized-dependent-exotic": [
    { name: "Delta-Neutral Positions (CEX)", pct: 50, risk: "high" },
    { name: "Stablecoins (USDC/USDT)", pct: 25, risk: "medium" },
    { name: "Volatile Crypto", pct: 25, risk: "high" },
  ],

  // Fully decentralized crypto-backed (LUSD-like): ETH-only CDPs
  "crypto-decentralized": [
    { name: "ETH / LSTs", pct: 80, risk: "medium" },
    { name: "Other On-Chain Collateral", pct: 20, risk: "high" },
  ],

  // Algorithmic: no traditional reserves, seigniorage/stability mechanisms
  algorithmic: [
    { name: "Protocol-Owned Reserves", pct: 50, risk: "high" },
    { name: "Algorithmic Stabilization", pct: 50, risk: "high" },
  ],

  // Gold-pegged stablecoins
  "commodity-gold": [
    { name: "Physical Gold Bullion", pct: 95, risk: "medium" },
    { name: "Cash / Operational", pct: 5, risk: "low" },
  ],

  // Silver-pegged stablecoins
  "commodity-silver": [
    { name: "Physical Silver Bullion", pct: 95, risk: "medium" },
    { name: "Cash / Operational", pct: 5, risk: "low" },
  ],
};

// ── Template key resolution ─────────────────────────────────────────────

function templateKey(coin: StablecoinMeta): string | null {
  const { backing, pegCurrency, governance } = coin.flags;

  // Commodity pegs get their own template regardless of other flags
  if (pegCurrency === "GOLD") return "commodity-gold";
  if (pegCurrency === "SILVER") return "commodity-silver";

  // Algorithmic coins share a single template
  if (backing === "algorithmic") return "algorithmic";

  // Cross backing × governance
  const base = `${backing === "rwa-backed" ? "rwa" : "crypto"}-${governance}`;

  // Refine crypto-centralized-dependent with collateralQuality if available
  if (base === "crypto-centralized-dependent" && coin.collateralQuality) {
    const refined = `${base}-${coin.collateralQuality}`;
    if (TEMPLATES[refined]) return refined;
  }

  return TEMPLATES[base] ? base : null;
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Returns reserve composition for a coin.
 * Uses manually curated data if available, otherwise falls back to a
 * category-based template derived from the coin's classification flags.
 */
export function getReserves(coin: StablecoinMeta): ReserveResult | null {
  // Prefer manually curated data
  if (coin.reserves && coin.reserves.length > 0) {
    return { reserves: coin.reserves, estimated: false };
  }

  // Fall back to template
  const key = templateKey(coin);
  if (!key) return null;

  return { reserves: TEMPLATES[key], estimated: true };
}
