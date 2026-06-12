import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V8: readonly MethodologyChangelogEntry[] = [
  {
    version: "8.1",
    title: "CDP oracle setup enters Decentralization",
    date: "2026-06-12",
    effectiveAt: 1781265600,
    summary:
      "Crypto-backed CDP stablecoins can now carry a reviewed oracle-risk profile. When present, the Decentralization dimension applies a penalty-only oracle setup blend for CDP liquidation and redemption price feeds: decentralization = min(current, 0.75 x current + 0.25 x oracle score). Robust oracle setups never lift the score, but weak, single-source, stale, or opaque feeds can drag it down.",
    impact: [
      "Oracle setup is scored only for crypto-backed CDP assets with an explicit reviewed oracleRisk profile; missing reviews and non-CDP assets remain unchanged",
      "The blend runs after governance and chain infrastructure, before the existing Mint Authority blend, and immutable-code CDPs are not exempt because liquidation oracles are an external dependency",
      "Oracle tiers score oracleless/internal setups at 100, redundant failover at 95, medianized delayed feeds at 85, standard external feeds at 75, single-source or laggy feeds at 45, and opaque/unknown setups at 20",
      "Report-card raw inputs now expose oracleRiskTier and oracleRiskScore for consumers that show report-card input details",
      "Initial reviewed metadata covers USDS (medianized-with-delay) and BOLD (redundant-with-failover); other CDP assets are unchanged until reviewed oracle profiles are curated",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "8.0",
    title: "Mint Authority Score enters Decentralization",
    date: "2026-06-11",
    effectiveAt: 1781208000,
    summary:
      "The Decentralization dimension now applies a penalty-only Mint Authority blend: decentralization = min(current, 0.65 x current + 0.35 x Mint Authority Score). A weak privileged-mint path can drag the dimension down; a strong one never lifts it. Coins without a rated Mint Authority Score are unchanged.",
    impact: [
      "Penalty-only blend at weight 0.35, applied after the governance baseline, wrapper inheritance, and the chain-infrastructure penalty",
      "Mint Authority Score NR (missing or unresolved review) leaves the dimension untouched - a missing review never penalizes",
      "No separate confidence gate: the Mint Authority confidence caps (verified 100 / probable 90 / manual-review 85) already encode evidence quality inside the score",
      "111 of 368 scoreable active coins move down, none up; biggest dimension drops are mint-incident and unbounded-mint protocols (DOLA 75 to 56, reUSD 55 to 39, MIM 45 to 33, USDe 45 to 38, crvUSD 85 to 77); USDT, USDC, LUSD, and BOLD are unchanged because their governance scores already reflect their mint topology",
      "Dimension weights, the peg multiplier, and the other four dimensions are unchanged; raw inputs now expose the blended mintAuthorityScore",
    ],
    commits: [],
    reconstructed: false,
  },
];
