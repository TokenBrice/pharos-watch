export interface StyleProperNoun {
  term: string;
  body: string;
}

export interface StyleAntiTerm {
  term: string;
  body: string;
}

export interface StyleNumberRule {
  topic: string;
  body: string;
}

export interface StyleToneAxiom {
  prefer: string;
  reject: string;
}

export const STYLE_LEAD =
  "How Pharos writes, what it calls things, and what it refuses to say. Pinned here so external commentators, contributors, and the maintainer can hold the project to its own register.";

export const STYLE_PROPER_NOUNS: readonly StyleProperNoun[] = [
  {
    term: "Pharos",
    body: "The publication and the platform. Used as a proper noun without article — Pharos tracks, Pharos publishes, Pharos refuses. Never \"the Pharos.\"",
  },
  {
    term: "PSI",
    body: "Pharos Stability Index. A 30-minute ecosystem score from 0–100 with five named bands. Always uppercase, never spaced or hyphenated.",
  },
  {
    term: "DEWS",
    body: "Depeg Early Warning System. Per-coin stress score, 0–100, recomputed every 30 minutes from supply velocity, pool drift, blacklist activity, and adjacent signals. Always uppercase.",
  },
  {
    term: "PegScore",
    body: "Composite peg-stability score, 0–100, with a power-curve multiplier into the safety grade. One word, capital P, capital S.",
  },
  {
    term: "LiquidityScore",
    body: "DEX liquidity score, 0–100, combining depth, durability, pair diversity, and quality-adjusted TVL. One word, capital L, capital S.",
  },
  {
    term: "FreezeWatch",
    body: "Live ledger of issuer-intervention events — freeze, unfreeze, pause, block, wipe — across supported contracts and chains. One word, capital F, capital W.",
  },
  {
    term: "Bluechip",
    body: "Pharos's gated designation for coins clearing strict floors across safety, liquidity, and resilience simultaneously. No weighted blend, no soft cutoffs. One word, capital B.",
  },
  {
    term: "PressureShift",
    body: "A measured change in DEWS pressure or PSI band that crosses a publishable threshold. Treated as an event, not a metric. One word, two capitals.",
  },
  {
    term: "Tape",
    body: "The wire-service stream at /timeline/. Capitalized when referring to the surface, lowercase when referring to the underlying stream of events (\"on tape\").",
  },
  {
    term: "Digest",
    body: "The editorial daily at /digest/. Capitalized when referring to the publication ritual; \"daily digest\" is the descriptive phrase.",
  },
  {
    term: "Cemetery",
    body: "The archive of decommissioned coins at /cemetery/. Capitalized as the proper noun for the surface; \"the cemetery\" is acceptable in body copy.",
  },
];

export const STYLE_DEWS_BANDS = ["Calm", "Watch", "Alert", "Warning", "Danger"] as const;

export const STYLE_GRADE_ALPHABET = [
  "A+",
  "A",
  "A-",
  "B+",
  "B",
  "B-",
  "C+",
  "C",
  "C-",
  "D",
  "F",
] as const;

export const STYLE_ANTI_TERMS: readonly StyleAntiTerm[] = [
  {
    term: "Decentralized",
    body: "Without qualification, the word is propaganda. Almost every stablecoin Pharos tracks involves a permissioned issuer, operator-gated mint or redeem, freeze authority, off-chain reserves, or some combination. Pharos says \"permissioned issuer,\" \"operator-gated,\" \"consensus-validated,\" or \"on-chain settled,\" never the unqualified word.",
  },
  {
    term: "Real-time proof of reserves",
    body: "Without third-party corroboration, the phrase is marketing. Attestations are dated; only audited and on-chain-verifiable reserves earn that wording. Pharos says \"issuer-reported reserves,\" \"attested reserves dated YYYY-MM-DD,\" or \"on-chain reserve read,\" and reserves the full phrase for assets where an independent party can corroborate the read.",
  },
  {
    term: "Stablecoin yield",
    body: "Not for NAV tokens. A token designed to drift upward to capture yield carries duration risk and does not trade at par. Pharos calls those tokenized treasuries, NAV-bearing instruments, or yield-bearing wrappers — never \"stablecoin yield.\" PegScore is withheld where the asset is not meant to hold a fixed price.",
  },
  {
    term: "Risk-free",
    body: "Nothing tracked here is risk-free. Pharos says \"operationally low-risk under current conditions\" or names the specific risk being absent (\"no issuer freeze authority,\" \"no upstream dependency,\" \"no documented redemption gate\"). Vague safety language is rewritten before publish.",
  },
  {
    term: "Emoji",
    body: "Not in product copy. The closest Pharos gets is a typographic kicker, a hairline rule, or a numbered marker. Emoji belong to social posts and changelog informalia, not to the dashboard, the methodology, or the briefings.",
  },
];

export const STYLE_NUMBER_RULES: readonly StyleNumberRule[] = [
  {
    topic: "Mono everywhere",
    body: "Every number Pharos renders is set in Geist Mono with tabular figures and a slashed zero. The pharos-numeric utility is the canonical handle. Proportional figures are reserved for body copy where digits are part of a sentence, not part of a table.",
  },
  {
    topic: "Basis points under 1%",
    body: "Peg deviations below one percent are expressed in basis points. \"USDC traded at –42 bps\" is correct; \"USDC traded at –0.42%\" is not. The threshold is one percent; at and above, switch to percent.",
  },
  {
    topic: "Percent at and above 1%",
    body: "Deviations at or above one percent are expressed in percent with one decimal. \"USDR closed –3.4%\" is correct; \"USDR closed –340 bps\" is not. The unit names the magnitude of the move.",
  },
  {
    topic: "USD scale",
    body: "USD with no decimals over $1B ($14B, $200B). One decimal between $100M and $1B ($420.0M, $999.9M). Two decimals under $100M ($12.34M, $0.42M). The scale is the proxy for precision; do not invent precision the underlying read does not support.",
  },
  {
    topic: "Time zones",
    body: "UTC unless otherwise noted. Timestamps render as YYYY-MM-DD HH:MM UTC in product chrome; \"08:14 UTC, May 21\" reads in body copy. Local times appear only when they are the story (Asia open, New York close), and they are labeled.",
  },
];

export const STYLE_TONE: readonly StyleToneAxiom[] = [
  { prefer: "Composed", reject: "Panicked" },
  { prefer: "Precise", reject: "Corporate" },
  { prefer: "Specific", reject: "Clever" },
  { prefer: "Authored", reject: "Generated-feeling" },
];

export const STYLE_TONE_NOTE =
  "Pharos publishes information that other people will cite. The four axioms above are the editorial test every line of product copy is reviewed against before publish. When a line could read either way, the right side loses.";
