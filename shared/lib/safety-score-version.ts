import { createMethodologyVersion } from "./methodology-version";

const safetyScore = createMethodologyVersion({
  currentVersion: "5.9",
  changelogPath: "/methodology/scoring-changelog/",
  changelog: [
    {
      version: "5.9",
      title: "Classification corrections: centralized-custody DeFi coins",
      date: "2026-03-20",
      effectiveAt: 1742428800,
      summary:
        "Three DeFi-classified coins with >50% centralized custody exposure reclassified to centralized-dependent based on live reserve data.",
      impact: [
        "meUSD, ALUSD, BtcUSD reclassified from decentralized to centralized-dependent",
        "ALUSD correction: 65% USDC+USDT direct exposure (reverts erroneous v4.1 reclassification)",
        "meUSD and BtcUSD: live reserves confirm 100% custodial BTC variants (WBTC, BTCB, cbBTC, SolvBTC)",
      ],
      commits: [],
      reconstructed: false,
    },
    {
      version: "5.8",
      title: "Live reserve passthrough for collateral quality",
      date: "2026-03-14",
      effectiveAt: 1773446400,
      summary:
        "Collateral quality scoring now consumes live reserve snapshots when available, using hourly data from reserve_composition instead of curated metadata.",
      impact: [
        "Coins with liveReservesConfig use fresh (<48h) live snapshots for collateral quality when >= 2 slices exist",
        "Delta alert fires when live-derived score diverges from curated by >15 points",
        "Dependency inference remains on curated data (live slices lack coinId links)",
      ],
      commits: [],
      reconstructed: true,
    },
    {
      version: "5.7",
      title: "Canonical ETH wrapper reserve alignment",
      date: "2026-03-13",
      effectiveAt: 1773360000,
      summary:
        "Reserve-derived collateral quality now treats direct ETH and canonical wrapped ETH as the same very-low-risk asset class.",
      impact: [
        "Canonical WETH no longer falls into the generic wrapped-asset bucket in the reserve-asset risk map",
        "Curated reserve metadata and live reserve-adapter overrides aligned for coins exposing ETH/WETH slices",
      ],
      commits: [],
      reconstructed: true,
    },
    {
      version: "5.6",
      title: "Exit-liquidity integration",
      date: "2026-03-12",
      effectiveAt: 1773273600,
      summary:
        "Safety Score liquidity now evaluates modeled exit quality via redemption backstops, not just raw DEX depth.",
      impact: [
        "Liquidity dimension uses effectiveExitScore, preserving DEX liquidity as floor while redemption quality can improve it",
        "Route-family caps prevent queue-based and offchain issuer systems from appearing unrealistically liquid",
      ],
      commits: [],
      reconstructed: true,
    },
    {
      version: "5.5",
      title: "Peg score fairness for young coins",
      date: "2026-03-01",
      effectiveAt: 1772323200,
      summary:
        "Three peg-scoring fixes prevent young coins with repeated brief depegs from being over-scored.",
      impact: [
        "Tracking window capped to coin age via coinTrackingStart()",
        "Severity magnitude floor ensures each depeg contributes a minimum penalty",
        "Steeper active-depeg penalty: max(5, absBps/50), capped at 50",
      ],
      commits: [],
      reconstructed: true,
    },
    {
      version: "5.4",
      title: "No-liquidity penalty",
      date: "2026-02-28",
      effectiveAt: 1772236800,
      summary:
        "When Liquidity is NR (no DEX data), overall score receives a 10% penalty instead of redistributing weight.",
      impact: [
        "NR liquidity now applies final *= 0.9 after peg multiplier instead of inflating other dimensions",
      ],
      commits: ["14131fa"],
      reconstructed: true,
    },
    {
      version: "5.3",
      title: "Remove chain infra from Resilience",
      date: "2026-02-28",
      effectiveAt: 1772236800,
      summary:
        "Chain infra double-counting fixed: removed from Resilience sub-factors, now exclusively in Decentralization.",
      impact: [
        "Resilience becomes a 3-factor model (collateral quality, custody model, blacklist capability)",
      ],
      commits: ["8c060b3"],
      reconstructed: true,
    },
    {
      version: "5.2",
      title: "Immutable-code governance tier",
      date: "2026-02-28",
      effectiveAt: 1772236800,
      summary:
        "Added immutable-code as highest GovernanceQuality tier (score 100) for protocols with no admin keys or upgrade path.",
      impact: [
        "LUSD, BOLD now score 100 in governance quality; exempt from chain infra penalty",
      ],
      commits: ["c6c0b77"],
      reconstructed: true,
    },
    {
      version: "5.1",
      title: "Regulated-entity tier + blacklist softening",
      date: "2026-02-28",
      effectiveAt: 1772236800,
      summary:
        "Blacklist scores softened (blacklistable 0->33) and regulated-entity governance tier added for licensed issuers.",
      impact: [
        "Blacklist scoring: blacklistable 0->33, possible 50->66, not-blacklistable stays 100",
        "Regulated-entity tier (score 40) auto-promoted from single-entity when regulator+license+independent audit",
        "Grade thresholds lowered another 5 points (A+ >= 87)",
      ],
      commits: ["38cbe20", "86b8ce1", "01ed304", "fc6cd6c"],
      reconstructed: true,
    },
    {
      version: "5.0",
      title: "GovernanceQuality + universal dependency scoring",
      date: "2026-02-28",
      effectiveAt: 1772236800,
      summary:
        "Decentralization moved from 3-tier to 6-tier GovernanceQuality. Dependency scoring became universal (not CeFi-only).",
      impact: [
        "GovernanceQuality tiers: dao-governance=85, multisig=55, single-entity=20, wrapper=10",
        "All coins with upstream dependencies now scored, not just centralized-dependent",
        "Chain infra scored as ChainTier x DeploymentModel multiplier in Resilience",
      ],
      commits: ["e915623", "e516bbf", "d4dd044", "0b603d2", "83a540a"],
      reconstructed: true,
    },
    {
      version: "4.1",
      title: "Liquidity weight increase + reclassifications",
      date: "2026-02-27",
      effectiveAt: 1772150400,
      summary:
        "Liquidity weight raised to 30% as the most defining stablecoin attribute. Five coins reclassified to decentralized.",
      impact: [
        "Weights: Liquidity 25->30%, Resilience 25->20%",
        "crvUSD, FRXUSD, USR, GYD, ALUSD reclassified from centralized-dependent to decentralized",
      ],
      commits: ["122733d"],
      reconstructed: true,
    },
    {
      version: "4.0",
      title: "Peg stability becomes a multiplier",
      date: "2026-02-27",
      effectiveAt: 1772150400,
      summary:
        "Biggest structural change: peg stability removed from weighted dimensions and applied as a post-hoc power-curve multiplier.",
      impact: [
        "Peg applied as final *= (pegScore/100)^0.20 instead of 25% dimension weight",
        "Grade thresholds lowered 5 points to compensate for structural deflation",
      ],
      commits: ["6ed2ec9"],
      reconstructed: true,
    },
    {
      version: "3.3",
      title: "Reserve-derived collateral quality",
      date: "2026-02-27",
      effectiveAt: 1772150400,
      summary:
        "For coins with curated reserves arrays, collateral quality is now a weighted average of reserve risk tiers instead of an enum fallback.",
      impact: [
        "Reserve risk tiers: very-low=100, low=75, medium=50, high=25, very-high=5",
        "Decentralization weight raised 10->15%",
      ],
      commits: ["25602d1", "1cd1bb9"],
      reconstructed: true,
    },
    {
      version: "3.2",
      title: "Dependency type ceilings",
      date: "2026-02-27",
      effectiveAt: 1772150400,
      summary:
        "New DependencyType field (wrapper/mechanism/collateral) with ceilings preventing wrappers from scoring above upstream.",
      impact: [
        "Wrapper ceiling = upstream_score - 3, mechanism ceiling = upstream_score, collateral = no ceiling",
      ],
      commits: ["fa1d992"],
      reconstructed: true,
    },
    {
      version: "3.0",
      title: "Resilience 4-factor model",
      date: "2026-02-26",
      effectiveAt: 1772064000,
      summary:
        "Complete Resilience redesign from 2 factors to 4 equal sub-factors: chain risk, collateral quality, custody model, blacklist capability.",
      impact: [
        "Chain risk, collateral quality, custody model, and blacklist each weighted 25%",
        "New types: ChainRisk, CollateralQuality, CustodyModel with tier-based scoring",
      ],
      commits: ["ff9d589", "46fe511", "c45f007"],
      reconstructed: true,
    },
    {
      version: "2.0",
      title: "Remove Safety dimension",
      date: "2026-02-26",
      effectiveAt: 1772064000,
      summary:
        "Safety dimension removed due to sparse Bluechip rating coverage (~20/142 coins). Bluechip display kept for informational use.",
      impact: [
        "Safety dimension dropped; weight redistributed to remaining 5 dimensions",
      ],
      commits: ["a272ca8"],
      reconstructed: true,
    },
    {
      version: "1.0",
      title: "Initial implementation",
      date: "2026-02-25",
      effectiveAt: 1771977600,
      summary:
        "First release with six weighted dimensions: Peg Stability, Liquidity, Safety, Resilience, Decentralization, and Dependency Risk.",
      impact: [
        "Six dimensions with grade thresholds from A+ (>=97) to F (>=0)",
        "Minimum 3 rated dimensions required for overall grade",
      ],
      commits: ["66ec5c4", "9c7ccc9", "c11e37c"],
      reconstructed: true,
    },
  ],
});

/** Canonical safety scoring methodology version (no "v" prefix). */
export const SAFETY_SCORE_VERSION = safetyScore.currentVersion;

/** Display-ready safety scoring methodology version (with "v" prefix). */
export const SAFETY_SCORE_VERSION_LABEL = safetyScore.versionLabel;

/** Public changelog route for Safety Scores methodology version history. */
export const SAFETY_SCORE_METHODOLOGY_CHANGELOG_PATH = safetyScore.changelogPath;

/** Resolve safety scoring methodology version active at a given Unix timestamp (seconds). */
export const getSafetyScoreVersionAt = safetyScore.getVersionAt;

/** Ordered scoring changelog versions used for the longform navigation rail. */
export const SAFETY_SCORE_CHANGELOG_NAV_VERSIONS = [
  safetyScore.versionLabel, // dynamic coupling to currentVersion
  "v5.7",
  "v5.6",
  "v5.5",
  "v5.4",
  "v5.3",
  "v5.2",
  "v5.1",
  "v5.0",
  "v4.1",
  "v4.0",
  "v3.3",
  "v3.2",
  "v3.0",
  "v2.0",
  "v1.0",
] as const;
