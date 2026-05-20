/**
 * Glossary of non-Pharos DeFi jargon used in stablecoin detail-page prose.
 *
 * For Pharos-specific concepts (PegScore, DEWS, PSI, PYS, etc.) use
 * `MethodologyLabel` from `@/components/methodology-hint` instead — those
 * route to `/methodology/`, this widget gives a 2-sentence definition only.
 */

export interface GlossaryEntry {
  /** Canonical display title shown in the popover. */
  term: string;
  /** 1-2 sentence plain-language definition. */
  short: string;
  /** Optional external link for deeper reading. */
  longHref?: string;
}

export const GLOSSARY = {
  cdp: {
    term: "CDP (Collateralized Debt Position)",
    short:
      "A vault that mints stablecoins against locked crypto collateral, liquidated if collateral value falls below a threshold.",
  },
  amo: {
    term: "AMO (Algorithmic Market Operations)",
    short:
      "Smart contracts that programmatically mint or burn stablecoins to manage the peg without direct user redemption.",
  },
  "basis-trade": {
    term: "Basis Trade",
    short:
      "Capturing the spread between spot and futures, typically by holding spot and shorting perps. Yield = the funding rate paid by perp longs.",
  },
  "delta-neutral": {
    term: "Delta-Neutral",
    short:
      "A position constructed so small price moves in the underlying don't change its value. Synthetic-dollar stablecoins like USDe use this design.",
  },
  psm: {
    term: "PSM (Peg Stability Module)",
    short:
      "A protocol module that lets users swap one stablecoin for another at a fixed rate, defending the peg through arbitrage.",
  },
  attestation: {
    term: "Attestation",
    short:
      "A periodic statement, typically by an audit firm, that the issuer's reserves match circulating supply at a point in time. Weaker than a full audit.",
  },
  redemption: {
    term: "Redemption",
    short:
      "Exchanging stablecoin tokens for the underlying asset (e.g., 1 USDC -> $1 USD wired to your bank) directly with the issuer.",
  },
  "yield-bearing": {
    term: "Yield-Bearing Stablecoin",
    short:
      "A stablecoin whose units accrue value over time rather than always trading at the peg. Examples: sUSDe, sUSDS, USDM.",
  },
  overcollateralization: {
    term: "Overcollateralization",
    short:
      "Holding more collateral than the value of stablecoins issued, so a price drop in collateral doesn't immediately undercollateralize the system.",
  },
  rwa: {
    term: "RWA (Real-World Asset)",
    short:
      "Off-chain assets — typically U.S. Treasuries, repos, or bank deposits — held as backing for an on-chain stablecoin.",
  },
  perpetual: {
    term: "Perpetual Future",
    short:
      "A derivatives contract with no expiry, kept aligned to spot via a periodic funding-rate payment between longs and shorts.",
  },
  custody: {
    term: "Custody",
    short:
      "Who physically holds the backing assets. Institutional custodians (BNY Mellon, BlackRock, Copper, Ceffu) carry different counterparty risk profiles.",
  },
  "funding-rate": {
    term: "Funding Rate",
    short:
      "Periodic payment between perpetual-futures longs and shorts that keeps the perp price tracking spot. Positive = longs pay shorts.",
  },
  liquidation: {
    term: "Liquidation",
    short:
      "Forced closure of an overleveraged CDP or perp position when collateral falls below the safety threshold. Common in CDP-backed stablecoins.",
  },
  bridge: {
    term: "Bridge",
    short:
      "Infrastructure that lets a stablecoin move between chains. Carries smart-contract and validator risk that the issuer often doesn't control.",
  },
  "money-market-fund": {
    term: "Money-Market Fund (MMF)",
    short:
      "A SEC-registered short-duration fund holding T-bills, repos, and cash. Used as the reserve vehicle for several major fiat-backed stablecoins.",
  },
  treasury: {
    term: "U.S. Treasury",
    short:
      "Short-dated U.S. government debt — the lowest-credit-risk USD-denominated reserve asset, used as the dominant backing for fiat-pegged stablecoins.",
  },
  algorithmic: {
    term: "Algorithmic Stablecoin",
    short:
      "A stablecoin that uses on-chain mint/burn rules (not 1:1 backing) to defend its peg. Generally riskier; UST/Terra was the canonical failure.",
  },
} as const satisfies Record<string, GlossaryEntry>;

export type GlossarySlug = keyof typeof GLOSSARY;
