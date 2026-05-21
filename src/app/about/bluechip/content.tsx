import type { ReactNode } from "react";

export interface BluechipGate {
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

export interface BluechipRefusal {
  readonly title: string;
  readonly body: string;
}

export const BLUECHIP_LEDE: ReactNode =
  "Pharos Bluechip is the gated designation for stablecoins that simultaneously clear strict floors across safety, liquidity, and resilience. There is no weighted blend, no soft cutoff, and no scoring formula that lets one dimension paper over another — every floor must hold at the same moment, and the label is withdrawn the day a floor breaks.";

export const BLUECHIP_WHAT_IT_MEANS: readonly string[] = [
  "Most stablecoin ratings are blends. A weighted average of safety, liquidity, and resilience can produce a confident grade for an asset that is excellent in two dimensions and broken in the third. Pharos Bluechip refuses that trade. The designation is a logical AND across floors, not a weighted sum: an asset is Bluechip only when each dimension clears its threshold simultaneously, and only while it continues to do so.",
  "The framing is deliberate. Bluechip is the editorial register Pharos uses for stablecoins that have earned the right to be cited as a peer of cash. The label is meant to be cited in the S&P AAA sense, not collected as a marketing badge — which is why Pharos withdraws Bluechip the moment any floor breaks, rather than waiting for a quarterly review cycle.",
];

export const BLUECHIP_GATES: readonly BluechipGate[] = [
  {
    id: "safety-floor",
    title: "Safety floor",
    body: "An A-tier Pharos Safety Score (A−, A, or A+) — composite grade from exit liquidity, resilience, decentralization, and dependency risk, then adjusted by peg stability. Missing data is penalized rather than redistributed. NR overall scores are disqualifying.",
  },
  {
    id: "liquidity-floor",
    title: "Liquidity floor",
    body: "A LiquidityScore clearing the top band of usable exit depth, computed from effective TVL, volume activity, pool quality, durability, and pair diversity. Thin, stale, or identity-poor pools remain visible for diagnostics but receive no scoring weight — Bluechip is a measure of exit capacity, not market presence.",
  },
  {
    id: "resilience-floor",
    title: "Resilience floor",
    body: "Top-tier collateral quality, custody model, and blacklist capability. Bluechip refuses to grant resilience credit for novel mechanisms without a multi-cycle track record. Algorithmic, partially uncollateralized, or experimental backing designs are disqualified at the resilience gate regardless of safety or liquidity standing.",
  },
  {
    id: "peg-floor",
    title: "Peg-stability floor",
    body: "PegScore in the top historical band, with no live active depeg and no recent severe-deviation incident within the rolling review window. A coin that has recently traded outside its peg band cannot hold Bluechip even when every other floor clears — the label is a statement about behavior under stress, not theoretical design.",
  },
  {
    id: "no-active-flags",
    title: "No active issuer flags",
    body: "No live FreezeWatch action that materially restricts holders, no unresolved blacklist tracker incident, no pending regulatory or custodial event that calls reserve access into question. Bluechip is a current-state rating, not a credit assignment.",
  },
];

export const BLUECHIP_REFUSALS: readonly BluechipRefusal[] = [
  {
    title: "No NAV-bearing tokens",
    body: "Tokens whose price moves with net asset value of an underlying portfolio are not stablecoins in the peg-holding sense Bluechip exists to measure. They may be excellent products; they are not eligible.",
  },
  {
    title: "No novel mechanism without a track record",
    body: "A new collateral or stabilization design can be intellectually superior on paper and still fail under conditions the design has never met. Resilience credit requires history under stress, not just specification.",
  },
  {
    title: "No off-chain backing without verifiable evidence",
    body: "Self-attested reserves, undisclosed custodians, or attestor tiers below independent CPA review do not meet the safety floor. Bluechip is a rating Pharos issues; it cannot be issued against backing Pharos cannot verify.",
  },
  {
    title: "No averaging across broken dimensions",
    body: "A weighted-average grading model would let an A+ on safety carry a D on liquidity into a respectable composite. Bluechip refuses that arithmetic by construction. Every floor stands on its own.",
  },
  {
    title: "No grandfathered status",
    body: "An asset that held Bluechip yesterday and breaks a floor today is not Bluechip today. The label tracks current state. Historical inclusion in the designation does not protect against a fresh failure.",
  },
];
