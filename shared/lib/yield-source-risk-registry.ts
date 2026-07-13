import type { YieldDependencyConcentration, YieldVenueRiskTier } from "../types/yield";
import { computeVenueRiskWeighted, deriveVenueRiskTier } from "./yield-scoring";
import type { YieldVenueRiskScores } from "./yield-scoring";

export const YIELD_RISK_CONFIG_REVIEW_CADENCE = "monthly-yield-coverage-audit";

// Shared scores for both Yearn venue slugs (yearn, yearn-finance).
// Edit this constant to update both entries simultaneously.
const YEARN_VENUE_SCORES: YieldVenueRiskScores = {
  audits: 2,
  centralization: 2,
  fundsManagement: 2,
  liquidity: 2,
  operational: 1,
};

// Shared scores for all Morpho venue slugs (morpho, morpho-v1, morpho-blue).
// Edit this constant to update all three entries simultaneously.
const MORPHO_VENUE_SCORES: YieldVenueRiskScores = {
  audits: 2,
  centralization: 4,
  fundsManagement: 3,
  liquidity: 2,
  operational: 2,
};

export const YIELD_RISK_CONFIG_PROTOCOLS = [
  "aave-v3",
  "compound-v3",
  "sparklend",
  "spark-savings",
  "maple",
  "yearn",
  "yearn-finance",
  "morpho",
  "morpho-v1",
  "morpho-blue",
  "pendle",
  "beefy",
  // Phase 2 (yield v8.292) — long-tail venues scored on the Yearn 5-category rubric
  // (2026-06-15). Slugs match the DeFiLlama `project` carried on auto-discovered
  // lending rows so the score binds without sourceKey inference.
  "clearpool",
  "goldfinch",
  "3jane-lending",
  "centrifuge",
  "flux-finance",
  "cap",
  "avantis",
  "euler-v2",
  "gearbox",
  "curve-llamalend",
  "fluid-lending",
  "dolomite",
  "exactly",
  "fraxlend-v2",
  "aave-v4",
  "compound-v2",
  "felix-cdp",
  "frankencoin",
  "kamino-lend",
  "justlend",
  "benqi-lending",
  "aries-markets",
  "scallop-lend",
  "echelon-market",
  "blend-pools-v2",
  "jupiter-lend",
  "hyperlend-pooled",
  "curvance",
  "sovryn-dex",
  // FU3 Wave 2 (yield v8.292, reviewed 2026-06-15) — risky unscored allowlist venues
  "truefi",
  "radiant-v2",
  "wildcat-protocol",
  "gains-network",
  "venus-core-pool",
  "moonwell-lending",
  "silo-v2",
  "sturdy-v2",
  "vesper",
  "convex-finance",
  "liqwid",
  "lista-lending",
  "loopscale",
  "navi-lending",
  "zest-v2",
  "resupply",
  "termmax",
  "upshift",
  "tectonic",
  "openeden-usdo",
] as const;

export type YieldRiskConfigProtocol = (typeof YIELD_RISK_CONFIG_PROTOCOLS)[number];

export interface YieldRiskConfigEntry {
  /**
   * Yearn-style 5-category venue-risk sub-scores (each 1..5, higher = riskier).
   * The coarse {@link YieldVenueRiskTier} and the PYS venue penalty are DERIVED
   * from these via the shared yield-scoring helpers (yield v8.292).
   */
  scores: YieldVenueRiskScores;
  reviewedAt: string;
  reviewCadence: typeof YIELD_RISK_CONFIG_REVIEW_CADENCE;
  confidence?: "verified" | "partial" | "low";
}

/** Weighted 1..5 venue-risk score for a reviewed config entry. */
export function venueRiskWeightedOf(entry: YieldRiskConfigEntry): number {
  return computeVenueRiskWeighted(entry.scores);
}

/** Coarse tier derived from a reviewed config entry's weighted score. */
export function venueRiskTierOf(entry: YieldRiskConfigEntry): YieldVenueRiskTier {
  return deriveVenueRiskTier(venueRiskWeightedOf(entry));
}

export const YIELD_RISK_CONFIG = {
  // Battle-tested money market since Aave V1 (2020) / V3 (2022); multi-billion-USD TVL
  // across 10+ chains; multiple independent audits and formal verification; mature
  // governance with safety-module stake. Low venue risk.
  "aave-v3": {
    scores: { audits: 1, centralization: 2, fundsManagement: 1, liquidity: 1, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-05-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  // Established Compound product line; isolated-asset V3 design has matured since 2022
  // with multiple audits and active COMP governance. Low venue risk.
  "compound-v3": {
    scores: { audits: 1, centralization: 2, fundsManagement: 1, liquidity: 1, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-05-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  // SparkLend is an Aave V3 fork deployed by Sky / former MakerDAO; benefits from
  // upstream audit inheritance, has a billion-plus TVL, and is operated through Sky
  // governance. Low venue risk.
  sparklend: {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "spark-savings": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 1, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  maple: {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  yearn: {
    scores: YEARN_VENUE_SCORES,
    confidence: "verified",
    reviewedAt: "2026-07-01",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "yearn-finance": {
    scores: YEARN_VENUE_SCORES,
    confidence: "verified",
    reviewedAt: "2026-07-01",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  morpho: {
    scores: MORPHO_VENUE_SCORES,
    confidence: "verified",
    reviewedAt: "2026-06-09",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "morpho-v1": {
    scores: MORPHO_VENUE_SCORES,
    confidence: "verified",
    reviewedAt: "2026-06-09",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  // Morpho Blue is the modern immutable lending primitive (January 2024). Audited
  // family but younger TVL cohort vs Aave/Compound. Medium venue risk reflects the
  // shorter live track record and the immutable design limiting remediation paths.
  "morpho-blue": {
    scores: MORPHO_VENUE_SCORES,
    confidence: "verified",
    reviewedAt: "2026-05-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  pendle: {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-09",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  beefy: {
    scores: { audits: 3, centralization: 3, fundsManagement: 3, liquidity: 2, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-09",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  // ── Phase 2 long-tail venues (yield v8.292, reviewed 2026-06-15) ──────────────
  // Uncollateralized / RWA credit (high tier — where `unknown`=0 was most wrong)
  clearpool: {
    scores: { audits: 3, centralization: 5, fundsManagement: 5, liquidity: 4, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  goldfinch: {
    scores: { audits: 2, centralization: 4, fundsManagement: 5, liquidity: 4, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "3jane-lending": {
    scores: { audits: 4, centralization: 4, fundsManagement: 4, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  centrifuge: {
    scores: { audits: 1, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "flux-finance": {
    scores: { audits: 2, centralization: 4, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  cap: {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  avantis: {
    scores: { audits: 3, centralization: 4, fundsManagement: 4, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  // EVM money markets / CDPs
  "euler-v2": {
    scores: { audits: 1, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  gearbox: {
    scores: { audits: 2, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "curve-llamalend": {
    scores: { audits: 2, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "fluid-lending": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-07-01",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  dolomite: {
    scores: { audits: 2, centralization: 4, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  exactly: {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "fraxlend-v2": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "aave-v4": {
    scores: { audits: 1, centralization: 3, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "compound-v2": {
    scores: { audits: 1, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "felix-cdp": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  frankencoin: {
    scores: { audits: 2, centralization: 1, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  // App-chain / non-EVM lenders
  "kamino-lend": {
    scores: { audits: 1, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 1 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  justlend: {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "benqi-lending": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "aries-markets": {
    scores: { audits: 3, centralization: 5, fundsManagement: 3, liquidity: 3, operational: 4 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "scallop-lend": {
    scores: { audits: 2, centralization: 3, fundsManagement: 2, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "echelon-market": {
    scores: { audits: 3, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "blend-pools-v2": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "jupiter-lend": {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "hyperlend-pooled": {
    scores: { audits: 3, centralization: 4, fundsManagement: 3, liquidity: 3, operational: 4 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  curvance: {
    scores: { audits: 4, centralization: 4, fundsManagement: 3, liquidity: 4, operational: 4 },
    confidence: "low",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "sovryn-dex": {
    scores: { audits: 4, centralization: 3, fundsManagement: 3, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  // ── FU3 Wave 2 venues (yield v8.292, reviewed 2026-06-15) ──────────────────
  truefi: {
    scores: { audits: 3, centralization: 3, fundsManagement: 5, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "radiant-v2": {
    scores: { audits: 5, centralization: 5, fundsManagement: 4, liquidity: 5, operational: 5 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "wildcat-protocol": {
    scores: { audits: 3, centralization: 2, fundsManagement: 5, liquidity: 5, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "gains-network": {
    scores: { audits: 2, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "venus-core-pool": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "moonwell-lending": {
    scores: { audits: 2, centralization: 3, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "silo-v2": {
    scores: { audits: 2, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "sturdy-v2": {
    scores: { audits: 3, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  vesper: {
    scores: { audits: 2, centralization: 3, fundsManagement: 3, liquidity: 2, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "convex-finance": {
    scores: { audits: 2, centralization: 3, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  liqwid: {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 4, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "lista-lending": {
    scores: { audits: 2, centralization: 2, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  loopscale: {
    scores: { audits: 4, centralization: 4, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "navi-lending": {
    scores: { audits: 2, centralization: 3, fundsManagement: 2, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "zest-v2": {
    scores: { audits: 3, centralization: 3, fundsManagement: 3, liquidity: 4, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  resupply: {
    scores: { audits: 4, centralization: 3, fundsManagement: 3, liquidity: 3, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  termmax: {
    scores: { audits: 2, centralization: 2, fundsManagement: 3, liquidity: 3, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  upshift: {
    scores: { audits: 2, centralization: 4, fundsManagement: 4, liquidity: 4, operational: 3 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  tectonic: {
    scores: { audits: 2, centralization: 3, fundsManagement: 2, liquidity: 3, operational: 3 },
    confidence: "partial",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
  "openeden-usdo": {
    scores: { audits: 2, centralization: 3, fundsManagement: 4, liquidity: 2, operational: 2 },
    confidence: "verified",
    reviewedAt: "2026-06-15",
    reviewCadence: YIELD_RISK_CONFIG_REVIEW_CADENCE,
  },
} satisfies Record<YieldRiskConfigProtocol, YieldRiskConfigEntry>;

const YIELD_RISK_CONFIG_PROTOCOL_ALIASES: Record<string, YieldRiskConfigProtocol> = {
  aave: "aave-v3",
  compound: "compound-v3",
  spark: "sparklend",
  "spark-lend": "sparklend",
  // Phase 2 venue slug variants → canonical reviewed key
  "clearpool-lending": "clearpool",
  sovryn: "sovryn-dex",
  fraxlend: "fraxlend-v2",
};

function isYieldRiskConfigProtocol(value: string): value is YieldRiskConfigProtocol {
  return Object.prototype.hasOwnProperty.call(YIELD_RISK_CONFIG, value);
}

function normalizeYieldRiskConfigProtocol(venueProtocol: string | null | undefined): YieldRiskConfigProtocol | null {
  if (typeof venueProtocol !== "string") return null;
  const normalized = venueProtocol.trim().toLowerCase();
  if (!normalized) return null;
  if (isYieldRiskConfigProtocol(normalized)) return normalized;
  return YIELD_RISK_CONFIG_PROTOCOL_ALIASES[normalized] ?? null;
}

export function resolveReviewedYieldRiskConfig(venueProtocol: string | null | undefined): YieldRiskConfigEntry | null {
  const protocol = normalizeYieldRiskConfigProtocol(venueProtocol);
  return protocol == null ? null : YIELD_RISK_CONFIG[protocol];
}

/**
 * Reviewer-set cross-venue dependency concentration, keyed by stablecoin id
 * (yield v8.292). Captures the risk that per-venue tiering structurally misses —
 * e.g. a vault whose strategy legs all sit behind one governance ecosystem, the
 * single risk Yearn's own yvUSDC report flags as dominant. Not auto-derived:
 * only set where the concentration is documented, so missing entries stay
 * neutral. See the source-risk section of `docs/yield-intelligence.md`.
 */
const YIELD_DEPENDENCY_CONCENTRATION: Record<string, YieldDependencyConcentration> = {
  // Penalty-worthy: a LOW venue tier (yearn-finance) hides a real single-ecosystem
  // (Sky) coupling — the canonical case the signal exists for.
  "yvusdc-yearn": {
    ecosystem: "Sky",
    severity: "medium",
    note: "Funded debt sits almost entirely in Sky-governed venues (sUSDS savings plus Spark Lend); a Sky incident would affect both legs simultaneously. Matches Yearn's own risk report flagging ~100% Sky-governance coupling.",
    reviewedAt: "2026-06-15",
  },
  // Informational (severity low = no added penalty): single-curator MetaMorpho
  // vaults whose apparent market-level diversification is bounded by one curator +
  // the Morpho protocol. Morpho protocol risk is already priced by the medium
  // venue tier, so this surfaces the curator coupling without double-counting.
  "gtusdc-gauntlet": {
    ecosystem: "Morpho (Gauntlet)",
    severity: "low",
    note: "All exposure is Morpho Blue lending markets allocated by a single curator (Gauntlet); apparent market diversification is bounded by one curator. Morpho protocol risk is already priced by the venue tier, so this is surfaced without an added penalty.",
    reviewedAt: "2026-06-15",
  },
  "gtusdcp-gauntlet": {
    ecosystem: "Morpho (Gauntlet)",
    severity: "low",
    note: "All exposure is Morpho Blue lending markets allocated by a single curator (Gauntlet); apparent market diversification is bounded by one curator. Morpho protocol risk is already priced by the venue tier, so this is surfaced without an added penalty.",
    reviewedAt: "2026-06-15",
  },
  "steakusdc-steakhouse": {
    ecosystem: "Morpho (Steakhouse)",
    severity: "low",
    note: "All exposure is Morpho lending markets allocated by a single curator (Steakhouse); apparent market diversification is bounded by one curator. Morpho protocol risk is already priced by the venue tier, so this is surfaced without an added penalty.",
    reviewedAt: "2026-06-15",
  },
  "bbqusdc-steakhouse": {
    ecosystem: "Morpho (Steakhouse Smokehouse)",
    severity: "low",
    note: "All exposure is Morpho lending markets allocated by Steakhouse's Smokehouse curator line; apparent market diversification is bounded by one curator. The higher-risk collateral mix is carried in stablecoin reserve metadata while Morpho protocol risk is already priced by the venue tier.",
    reviewedAt: "2026-06-20",
  },
  "steakusdt-steakhouse": {
    ecosystem: "Morpho (Steakhouse)",
    severity: "low",
    note: "All exposure is Morpho lending markets allocated by a single curator (Steakhouse); apparent market diversification is bounded by one curator. Morpho protocol risk is already priced by the venue tier, so this is surfaced without an added penalty.",
    reviewedAt: "2026-06-15",
  },
  // syrupUSDC/USDT yield is originated by a single off-chain Pool Delegate EOA
  // ("Maple Direct") controlling ~97% of AUM loan origination/impairments with no
  // on-chain governance gate. Surfaced at LOW severity (informational, no penalty)
  // because the `maple` venue tier already prices the credit/delegate risk — a HIGH
  // entry would double-count it. Matches the single-curator Morpho chips above.
  // Source: Yearn maple-syrupUSDC dependency graph (2026-07-01 cross-check).
  "syrupusdc-maple": {
    ecosystem: "Maple (Pool Delegate)",
    severity: "low",
    note: "syrupUSDC's yield is originated by a single off-chain Pool Delegate EOA ('Maple Direct') that controls loan origination and impairments for ~97% of AUM with no on-chain governance gate. Surfaced without an added penalty because the medium `maple` venue tier already prices the credit/delegate risk.",
    reviewedAt: "2026-07-01",
  },
  "syrupusdt-maple": {
    ecosystem: "Maple (Pool Delegate)",
    severity: "low",
    note: "syrupUSDT shares syrupUSDC's single off-chain Pool Delegate ('Maple Direct') for loan origination and impairments. Surfaced without an added penalty because the medium `maple` venue tier already prices the credit/delegate risk.",
    reviewedAt: "2026-07-01",
  },
};

export function resolveDependencyConcentration(
  stablecoinId: string | null | undefined,
): YieldDependencyConcentration | null {
  if (typeof stablecoinId !== "string") return null;
  return YIELD_DEPENDENCY_CONCENTRATION[stablecoinId] ?? null;
}

/** Venue-risk scores older than this are flagged for re-review (yield v8.292). */
const VENUE_RISK_SCORE_MAX_AGE_DAYS = 90;

export interface StaleVenueRiskScore {
  protocol: YieldRiskConfigProtocol;
  reviewedAt: string;
  ageDays: number;
  confidence: YieldRiskConfigEntry["confidence"];
}

/**
 * Venue-risk scores encode point-in-time facts (audit counts, governance events,
 * TVL) and rot. Returns entries whose `reviewedAt` is older than `maxAgeDays` so
 * the monthly yield-coverage audit can queue them for re-verification.
 */
export function findStaleVenueRiskScores(
  nowMs: number,
  maxAgeDays: number = VENUE_RISK_SCORE_MAX_AGE_DAYS,
): StaleVenueRiskScore[] {
  const stale: StaleVenueRiskScore[] = [];
  for (const protocol of YIELD_RISK_CONFIG_PROTOCOLS) {
    const entry = YIELD_RISK_CONFIG[protocol];
    const reviewedMs = Date.parse(`${entry.reviewedAt}T00:00:00Z`);
    if (!Number.isFinite(reviewedMs)) continue;
    const ageDays = Math.floor((nowMs - reviewedMs) / 86_400_000);
    if (ageDays > maxAgeDays) {
      stale.push({ protocol, reviewedAt: entry.reviewedAt, ageDays, confidence: entry.confidence });
    }
  }
  return stale.sort((a, b) => b.ageDays - a.ageDays);
}
