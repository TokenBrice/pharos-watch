import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V8: readonly MethodologyChangelogEntry[] = [
  {
    version: "8.14",
    title: "Dependency derivation rejects self-links and duplicate variant backing",
    date: "2026-07-12",
    effectiveAt: 1783896306,
    summary:
      "Dependency Risk now suppresses self-referential reserve links at the adapter and canonical resolver boundaries, treats tracked variants as one serial wrapper claim on their parent instead of counting the parent's backing twice, and publishes typed dependency-source and fallback provenance.",
    impact: [
      "Frax balance-sheet mappings are subject-aware, so a coin's treasury-held own token remains visible as backing without creating an upstream self-edge",
      "The canonical resolver and graph builders defensively suppress self-links, while static metadata and live reserve write/read validation reject malformed, unknown, or self-referential dependency targets",
      "Tracked variants emit one weight-1 wrapper edge to the parent; reserve views can still show the parent's backing composition, but those slices no longer become parallel dependency weight",
      "Raw inputs expose dependency source, base source, mapped live weight, typed fallback reason, and score-grade live snapshot source/time while remaining backward-compatible with older cached cards",
      "Fixed-input all-card calibration moved FRAX from 58 to 59 and sUSDai from 59 to 57, removed two graph edges, and produced no grade crossing or NR change",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "8.13",
    title: "All-unmapped live reserve dependencies fall back to curated links",
    date: "2026-06-19",
    effectiveAt: 1781870400,
    summary:
      "Dependency Risk now treats score-grade live reserve snapshots with no mapped tracked-asset links as insufficient dependency evidence when curated reserve or manual dependency links exist. Partial live mappings remain authoritative, and only the all-unmapped live case falls back to curated/manual dependency evidence.",
    impact: [
      "Live reserve slices with mapped `coinId` links still drive Dependency Risk, raw dependency inputs, topological ordering, and dependency graph edges",
      "Unmapped remainder inside a partially mapped live snapshot remains self-backed or non-stablecoin reserve share instead of reviving stale curated percentages",
      "When a score-grade live snapshot has zero mapped `coinId` links, Dependency Risk falls back to curated reserve links, then manual dependencies, before treating the asset as live-unmapped/self-backed",
      "The `dependencyFromLive` raw-input flag is false for fallback-derived dependencies and true only when the effective dependency set is live-derived or explicitly live-unmapped with no fallback evidence",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "8.12",
    title: "Bridge-route risk enters Decentralization",
    date: "2026-06-12",
    effectiveAt: 1781292600,
    summary:
      "Reviewed bridge-route profiles now feed the Decentralization dimension through a penalty-only blend after CDP oracle scoring and before Mint Authority. L2BEAT Interop data is used as static review evidence and queue material, while live scoring consumes only curated Pharos bridgeRouteRisk metadata.",
    impact: [
      "bridgeRouteRisk metadata can now record reviewed route tier, summary, provenance, confidence, protocol evidence, and sources",
      "Penalty-only blend at weight 0.20: decentralization = min(current, 0.80 x current + 0.20 x bridge route score)",
      "Missing bridge-route reviews remain neutral and strong issuer-native or canonical routes never lift a score",
      "Weak external lock/mint, liquidity, intent, or opaque route reviews can drag Decentralization before the Mint Authority blend",
      "The L2BEAT Interop candidate queue proposes review targets, but report-card scoring has no live L2BEAT dependency",
      "Initial reviewed bridge-route profiles cover USDC, USDCx, USDB, and NUSD",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "8.11",
    title: "Oracle-risk profiles gain provenance and branch handling",
    date: "2026-06-12",
    effectiveAt: 1781289000,
    summary:
      "Reviewed CDP oracle-risk profiles now carry review provenance, confidence, optional collateral-branch rows, and a report-card presentation object. When branch rows are present, the Decentralization oracle blend uses the weakest branch/profile score so multi-collateral CDPs cannot hide a weaker oracle path behind an aggregate label.",
    impact: [
      "oracleRisk metadata can now include reviewedAt, reviewer, confidence, and per-branch collateral/chains/source rows",
      "Branch-aware scoring is conservative: the lowest-scoring branch/profile tier drives the same penalty-only v8.1 oracle blend",
      "Report-card payloads expose a display-only oracleRisk object with summary, sources, selected branch, and inherited parent context for wrappers and variants",
      "A warning-only oracle-risk coverage check and an oracle-risk calibration report help finish the CDP backfill and review the 25% blend after coverage is complete",
      "BOLD now records WETH, wstETH, and rETH branch rows; USDS and BOLD profiles now carry review provenance",
    ],
    commits: [],
    reconstructed: false,
  },
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
      "Dimension weights, the peg multiplier, and the other four dimensions are unchanged; raw inputs now expose the standalone mintAuthorityScore input",
    ],
    commits: [],
    reconstructed: false,
  },
];
