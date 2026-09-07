import {
  BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
  DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
  LIQUIDITY_METHODOLOGY_VERSION_LABEL,
  MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
  PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
  PSI_METHODOLOGY_VERSION_LABEL,
  SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/constants";

export interface GlossaryEntryExample {
  label: string;
  href: string;
}

export interface GlossaryEntry {
  /** URL-safe slug. Used as the on-page anchor and as a `seeAlso` reference. */
  id: string;
  /** Title-Case display term: the proper-noun spelling Pharos publishes. */
  term: string;
  /** Single uppercase letter for the alphabetical jump rail. */
  letter: string;
  /** Authored definition, ≤ 80 words, written for citation. */
  definition: string;
  /** Path with anchor to the section of /methodology/ that defines the term. */
  methodologyAnchor: string;
  /** Methodology version pin for the relevant section at time of authoring. */
  methodologyVersion: string;
  /** Optional historical reference: one named incident, one link. */
  example?: GlossaryEntryExample;
  /** Other glossary entries worth pairing with this one. */
  seeAlso?: readonly string[];
}

export const GLOSSARY_LEAD =
  "The Pharos vocabulary, alphabetized. Each entry is authored, version-pinned to the methodology section that defines it, and linked to one historical incident wherever the record has one. The glossary is the page Pharos can be cited against.";

export const GLOSSARY_ENTRIES: readonly GlossaryEntry[] = [
  {
    id: "bluechip",
    term: "Bluechip",
    letter: "B",
    definition:
      "Pharos's gated designation for stablecoins clearing strict floors across safety, liquidity, and resilience simultaneously. There is no weighted blend and no soft cutoff: an asset is Bluechip only when every floor is cleared at the same moment. The label is withdrawn the day a floor breaks. Bluechip is a rating in the S&P AAA sense, not a marketing badge.",
    methodologyAnchor: "/methodology/#safety-scores-methodology",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["pegscore", "liquidity-score", "safety-score"],
  },
  {
    id: "calm-watch-alert-warning-danger",
    term: "Calm, Watch, Alert, Warning, Danger",
    letter: "C",
    definition:
      "The five DEWS bands, ordered from cool to hot. Calm covers scores at or below 15; Watch up to 35; Alert up to 55; Warning up to 75; Danger above 75. Each band is a Title-Case proper noun in product copy. Lowercased forms (“a calmer week”) refer to ordinary weather and never name the band.",
    methodologyAnchor: "/methodology/#pegscore-dews-methodology",
    methodologyVersion: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["dews", "pegscore"],
  },
  {
    id: "cemetery",
    term: "Cemetery",
    letter: "C",
    definition:
      "Pharos's archive of decommissioned stablecoins. Each entry preserves the asset's historical data, an authored obituary, and the cause of death: algorithmic failure, liquidity drain, custodial failure, regulatory action, or abandonment. The Cemetery is a citeable archive of failure, not a graveyard joke; the tombstone register is a discipline, not a theme.",
    methodologyAnchor: "/methodology/#lifecycle-phases-methodology",
    methodologyVersion: "v7.26",
    example: {
      label: "Example: TerraUSD, May 2022. See cemetery entry →",
      href: "/cemetery/",
    },
    seeAlso: ["digest", "tape"],
  },
  {
    id: "depeg",
    term: "Depeg",
    letter: "D",
    definition:
      "A deviation from peg that crosses a publishable band threshold. Pharos expresses deviations in basis points below one percent and percent at or above. A confirmed depeg requires same-direction corroboration across source families; contradictory secondary evidence is treated as contradiction, not weak support. Events with peak deviation at or above 500 bps earn a dedicated incident page.",
    methodologyAnchor: "/methodology/#pegscore-dews-methodology",
    methodologyVersion: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    example: {
      label: "Example: USDC, March 11, 2023. See incident page →",
      href: "/depeg/usdc-2023-03-11/",
    },
    seeAlso: ["dews", "pegscore", "pressureshift"],
  },
  {
    id: "dews",
    term: "DEWS",
    letter: "D",
    definition:
      "Depeg Early Warning System. A forward-looking per-coin stress score, 0 to 100, recomputed every 30 minutes from eight weighted sub-signals: price deviation, source divergence, liquidity erosion, pool imbalance, supply velocity, blacklist activity, mint/burn pressure, and yield anomalies. PSI condition and same-peg contagion can amplify the score before it lands in a band. Always uppercase, never spaced.",
    methodologyAnchor: "/methodology/#pegscore-dews-methodology",
    methodologyVersion: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    example: {
      label: "Example: TerraUSD's death spiral. Read the case study →",
      href: "/learn/case-studies/terra-ust-2022/",
    },
    seeAlso: ["pegscore", "psi", "calm-watch-alert-warning-danger"],
  },
  {
    id: "digest",
    term: "Digest",
    letter: "D",
    definition:
      "Pharos's editorial daily, published at /digest/. The Digest reads the previous day's stablecoin movements as a single briefing covering mint/burn pressure, PSI shifts, confirmed depegs, and FreezeWatch entries, not as a feed dump. Capitalized when referring to the publication ritual; “daily digest” is the descriptive phrase. The Digest carries the editorial signature for the platform.",
    methodologyAnchor: "/methodology/#pricing-pipeline-methodology",
    methodologyVersion: PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["tape", "cemetery"],
  },
  {
    id: "freezewatch",
    term: "FreezeWatch",
    letter: "F",
    definition:
      "The live ledger of issuer-intervention events (freeze, unfreeze, pause, block, wipe) across supported centralized stablecoin contracts. Events are normalized by chain, action type, native amount, and USD amount, with provenance attached. FreezeWatch is the surface Pharos publishes for issuer power; the underlying methodology is the Blacklist Tracker. One word, capital F, capital W.",
    methodologyAnchor: "/methodology/#blacklist-tracker-methodology",
    methodologyVersion: BLACKLIST_TRACKER_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["bluechip", "safety-score"],
  },
  {
    id: "liquidity-score",
    term: "LiquidityScore",
    letter: "L",
    definition:
      "DEX liquidity score, 0 to 100, combining TVL depth (30%), 24-hour volume (20%), pool quality (20%), durability (20%), and pair diversity (10%). Discovery is source-aware: thin, stale, or identity-poor pools remain visible for diagnostics but do not receive scoring weight. LiquidityScore measures exit capacity, not market presence. One word, capital L, capital S.",
    methodologyAnchor: "/methodology/#liquidity-methodology",
    methodologyVersion: LIQUIDITY_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["bluechip", "safety-score"],
  },
  {
    id: "mint-burn-pressure",
    term: "Mint/Burn Pressure",
    letter: "M",
    definition:
      "Net mint-versus-burn flow across supported issuance-chain contracts, scored against trailing closed-day baselines. Transfers are classified into mint, burn, bridge-mint, bridge-burn, atomic roundtrip, and ignored noise so the gauge reflects meaningful supply movement rather than mechanical churn. Pressure shifts when risky outflows and safer inflows diverge.",
    methodologyAnchor: "/methodology/#mint-burn-flow-methodology",
    methodologyVersion: MINT_BURN_FLOW_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["pressureshift", "dews"],
  },
  {
    id: "pegscore",
    term: "PegScore",
    letter: "P",
    definition:
      "Composite peg-stability score, 0 to 100. PegScore combines time-at-peg (50%) and event severity (50%) over a window capped by the coin's actual age, then enters the safety grade through a power-curve multiplier at exponent 0.40. The multiplier prevents a structurally strong asset with a bad peg from receiving an inflated grade. One word, capital P, capital S.",
    methodologyAnchor: "/methodology/#pegscore-dews-methodology",
    methodologyVersion: DEPEG_DEWS_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["dews", "safety-score", "depeg"],
  },
  {
    id: "pharos",
    term: "Pharos",
    letter: "P",
    definition:
      "The publication and the platform. Pharos tracks every meaningful stablecoin: what backs it, what could freeze it, and how the peg holds under stress. The work is independent, methodological, and citable. Used as a proper noun without article: Pharos tracks, Pharos publishes, Pharos refuses. Never “the Pharos.”",
    methodologyAnchor: "/methodology/",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["digest", "tape", "cemetery"],
  },
  {
    id: "pressureshift",
    term: "PressureShift",
    letter: "P",
    definition:
      "A measured change in DEWS pressure or PSI band that crosses a publishable threshold. Treated as an event, not a metric: a PressureShift is the moment something on the tape changes register, not the running number underneath. Surfaces on the Tape and in the Digest. One word, two capitals.",
    methodologyAnchor: "/methodology/#stability-index-methodology",
    methodologyVersion: PSI_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["psi", "dews", "tape"],
  },
  {
    id: "psi",
    term: "PSI",
    letter: "P",
    definition:
      "Pharos Stability Index. A 30-minute ecosystem-wide condition score, 0 to 100, that subtracts penalties for severity, breadth, and stress breadth, then adds a clamped trend term. The result maps into six condition bands from BEDROCK to MELTDOWN. PSI is conservative by design: one small depeg should not move the index, but simultaneous broad stress should. Always uppercase.",
    methodologyAnchor: "/methodology/#stability-index-methodology",
    methodologyVersion: PSI_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["dews", "pressureshift"],
  },
  {
    id: "safety-score",
    term: "Safety Score",
    letter: "S",
    definition:
      "Pharos's V9 risk grade for a stablecoin. It evaluates Backing (40%), Exit (35%), and Economic Control (25%) with bounded aggregation, then applies peg, evidence, dependency, wrapper, track-record, and structural constraints. Grades run A+ (87+) through F (0 to 39), with NR for insufficient required evidence.",
    methodologyAnchor: "/methodology/#safety-scores-methodology",
    methodologyVersion: SAFETY_SCORE_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["bluechip", "pegscore", "liquidity-score"],
  },
  {
    id: "tape",
    term: "Tape",
    letter: "T",
    definition:
      "The wire-service stream at /timeline/. The Tape is set in Courier and reads like a newsroom feed: PressureShifts, confirmed depegs, FreezeWatch entries, blacklist actions, and PSI band changes, time-stamped in UTC and source-attributed. Capitalized when referring to the surface; lowercase when referring to the underlying stream (“on tape”).",
    methodologyAnchor: "/methodology/#pricing-pipeline-methodology",
    methodologyVersion: PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["digest", "pressureshift"],
  },
  {
    id: "yieldscore",
    term: "YieldScore",
    letter: "Y",
    definition:
      "Pharos's yield-confidence rating for stablecoins and NAV-bearing instruments. The Pharos Yield Score (PYS) combines source-risk-adjusted yield efficiency with sustainability; high APY is not automatically good. Unstable rates, weak safety scores, low TVL, source-risk penalties, or ambiguous exposure reduce the recommendation quality. Withheld where the asset is not meant to hold a fixed price.",
    methodologyAnchor: "/methodology/#yield-intelligence-methodology",
    methodologyVersion: YIELD_METHODOLOGY_VERSION_LABEL,
    seeAlso: ["safety-score"],
  },
];

export interface GlossaryLetterGroup {
  letter: string;
  entries: readonly GlossaryEntry[];
}

/** Stable alphabetical grouping for the rendered list. */
export function groupGlossaryByLetter(
  entries: readonly GlossaryEntry[] = GLOSSARY_ENTRIES,
): readonly GlossaryLetterGroup[] {
  const buckets = new Map<string, GlossaryEntry[]>();
  for (const entry of entries) {
    const bucket = buckets.get(entry.letter) ?? [];
    bucket.push(entry);
    buckets.set(entry.letter, bucket);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([letter, group]) => ({
      letter,
      entries: [...group].sort((a, b) => a.term.localeCompare(b.term)),
    }));
}
