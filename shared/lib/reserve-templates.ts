import type {
  ReserveDisplayBadgeView,
  LiveReserveSnapshotMetadata,
  ReserveProvenanceView,
  ReservePresentationMode,
  ReserveSlice,
  ReserveSyncStateView,
  StablecoinMeta,
} from "../types";

export interface ReserveResult {
  reserves: ReserveSlice[];
  estimated: boolean; // true if using template, false if manually curated
  mode: ReservePresentationMode;
  /** Unix seconds. Present when reserves came from a live sync (not static). */
  liveAt?: number;
  /** Adapter key. Present when reserves came from a live sync. */
  source?: string;
  /** Human-readable URL to link to. Present when reserves came from a live sync. */
  displayUrl?: string;
  /** Adapter-emitted evidence URLs for the authoritative live snapshot. */
  evidenceUrls?: string[];
  /** User-facing badge semantics for authoritative live reserve snapshots. */
  displayBadge?: ReserveDisplayBadgeView;
  /** Adapter-level metadata for authoritative live reserve snapshots. */
  metadata?: LiveReserveSnapshotMetadata;
  /** Evidence-quality metadata for live reserve snapshots. */
  provenance?: ReserveProvenanceView;
  /** Sync-state metadata for live-enabled reserve feeds. */
  sync?: ReserveSyncStateView;
}

// ── Default reserve templates by classification ─────────────────────────

const TEMPLATES: Record<string, ReserveSlice[]> = {
  "rwa-centralized": [
    { name: "U.S. Treasuries / Gov Securities", pct: 70, risk: "very-low" },
    { name: "Cash & Bank Deposits", pct: 20, risk: "very-low" },
    { name: "Other Reserves", pct: 10, risk: "low" },
  ],
  "rwa-centralized-dependent": [
    { name: "Tokenized Treasuries / RWA", pct: 50, risk: "very-low" },
    { name: "Stablecoin Reserves (USDC/USDT)", pct: 35, risk: "low" },
    { name: "Other Assets", pct: 15, risk: "low" },
  ],
  "crypto-centralized": [
    { name: "Stablecoins (USDC/USDT)", pct: 40, risk: "low" },
    { name: "BTC / ETH Positions", pct: 40, risk: "medium" },
    { name: "Other Crypto", pct: 20, risk: "high" },
  ],
  "crypto-centralized-dependent": [
    { name: "ETH / LSTs", pct: 35, risk: "low" },
    { name: "Stablecoin Collateral", pct: 30, risk: "low" },
    { name: "BTC / wBTC", pct: 15, risk: "medium" },
    { name: "Other Vaults / Assets", pct: 20, risk: "high" },
  ],
  "crypto-centralized-dependent-rwa": [
    { name: "RWA (Treasuries / Tokenized)", pct: 40, risk: "very-low" },
    { name: "Stablecoin PSM", pct: 30, risk: "low" },
    { name: "ETH / LSTs", pct: 20, risk: "low" },
    { name: "Other Vaults", pct: 10, risk: "high" },
  ],
  "crypto-centralized-dependent-exotic": [
    { name: "Delta-Neutral Positions (CEX)", pct: 50, risk: "high" },
    { name: "Stablecoins (USDC/USDT)", pct: 25, risk: "low" },
    { name: "Volatile Crypto", pct: 25, risk: "high" },
  ],
  "crypto-decentralized": [
    { name: "ETH / LSTs", pct: 80, risk: "low" },
    { name: "Other On-Chain Collateral", pct: 20, risk: "high" },
  ],
  algorithmic: [
    { name: "Protocol-Owned Reserves", pct: 50, risk: "high" },
    { name: "Algorithmic Stabilization", pct: 50, risk: "very-high" },
  ],
  "commodity-gold": [
    { name: "Physical Gold Bullion", pct: 95, risk: "very-low" },
    { name: "Cash / Operational", pct: 5, risk: "very-low" },
  ],
  "commodity-silver": [
    { name: "Physical Silver Bullion", pct: 95, risk: "very-low" },
    { name: "Cash / Operational", pct: 5, risk: "very-low" },
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
    return { reserves: coin.reserves, estimated: false, mode: "curated-fallback" };
  }

  // Fall back to template
  const key = templateKey(coin);
  if (!key) return null;

  return { reserves: TEMPLATES[key], estimated: true, mode: "template-fallback" };
}
