// Single source of truth for the 12 event classes that appear on /tape/.
// Imported by the filters chip row, the ItemList JSON-LD, and the per-class
// "See all on Tape" deep-link footers on /depeg/, /freezewatch/, /flows/.
//
// Slugs match the first dot-segment of `tape_events.type` (per plan §3.3).

export interface TapeClassDef {
  slug: string;
  /** Short label shown on chips and ItemList entries. */
  label: string;
  /** Slightly longer label for the JSON-LD ItemList description. */
  description: string;
}

export const TAPE_CLASSES: readonly TapeClassDef[] = [
  { slug: "depeg",       label: "Depegs",       description: "Confirmed and pending peg deviations." },
  { slug: "freeze",      label: "Freezes",      description: "Issuer freeze, unblock, and fund-destroy events." },
  { slug: "score",       label: "Grade changes", description: "Stablecoin Safety Score upgrades and downgrades." },
  { slug: "dews",        label: "DEWS bands",   description: "Depeg Early Warning System band transitions." },
  { slug: "psi",         label: "PSI bands",    description: "Pharos Stability Index band shifts." },
  { slug: "mint_burn",   label: "Mint/burn",    description: "Bank-run gauge, FTQ, and pressure-shift events." },
  { slug: "reserve",     label: "Reserves",     description: "Reserve composition drifts and sync recoveries." },
  { slug: "redemption",  label: "Redemption",   description: "Redemption route impairment and recovery." },
  { slug: "yield",       label: "Yield",        description: "Yield warning signals and PYS drops." },
  { slug: "liquidity",   label: "Liquidity",    description: "DEX liquidity score and coverage class shifts." },
  { slug: "methodology", label: "Methodology",  description: "Methodology version bumps." },
  { slug: "lifecycle",   label: "Lifecycle",    description: "Tracked coin lifecycle and cemetery additions." },
] as const;
