import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const SAFETY_SCORE_V8: readonly MethodologyChangelogEntry[] = [
  {
    version: "8.17",
    title: "Aggregate pool balances remain TVL evidence",
    date: "2026-07-13",
    effectiveAt: 1783908149,
    summary:
      "Liquidity / Exit no longer labels balance-measured aggregate pool TVL as reserve-based AMM simulation when the retained row lacks an exact invariant, fee, output identity, and executable capacity curve.",
    impact: [
      "Balance measurement continues to improve DEX coverage and pool-quality inputs but does not by itself prove executable same-notional depth",
      "Aggregate measured rows use the existing generic-TVL-proxy ceiling of 60 instead of the reserve-based AMM simulation ceiling of 85",
      "The reserve-based AMM simulation class remains available only to exact route observations with modeled pool mechanics; P4b same-notional scoring remains inactive until its rollout gate passes",
      "The standalone public Liquidity Score is unchanged",
    ],
    detail: [
      {
        kind: "paragraph",
        text: "Balance-measured aggregate pool TVL is no longer treated as a reserve-based AMM simulation unless the retained evidence includes the exact mechanics needed to model executable capacity.",
      },
      {
        kind: "list",
        items: [
          "Aggregate balance measurements remain useful DEX coverage and pool-quality evidence.",
          "Without an exact invariant, fee, output identity, and capacity curve, the Safety Score applies the existing generic-TVL-proxy ceiling of 60 rather than the AMM-simulation ceiling of 85.",
          "The standalone Liquidity Score is unchanged.",
          "Same-notional route scoring remains inactive until the P4b rollout gate passes.",
        ],
      },
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "8.16",
    title: "DEX exit scoring carries evidence quality",
    date: "2026-07-12",
    effectiveAt: 1783900400,
    summary:
      "Liquidity / Exit now retains DEX coverage, measurement, effective-TVL, and deployment-access evidence and applies conservative ceilings when the published DEX score rests on reserve simulation, generic TVL proxies, synthetic fallback, or inaccessible-only coverage rather than measured executable depth.",
    impact: [
      "Report-card DEX snapshot reads preserve coverage class and confidence, evidence class, measured-balance and organic TVL, effective TVL, and aggregate deployment outcomes",
      "Rows without republished evidence fields and rows explicitly marked legacy remain score-neutral and parse through the existing optional raw-input contract",
      "Reserve-based AMM simulation is capped at 85, generic TVL proxy evidence at 60, and synthetic or fallback evidence at 55; a row with provider-inaccessible deployments and no observed deployment is capped at 45",
      "The standalone public Liquidity Score is unchanged; the evidence-adjusted DEX value is used only as the Safety Score effective-exit input and is exposed beside the observed score and binding evidence ceiling",
      "Fixed-input calibration changed 18 overall scores and 9 grades with no NR transitions; the largest moves were XSGD 80/A- to 72/B, IDRX 69/B- to 63/C+, and HOLLAR 53/C- to 48/D",
    ],
    detail: [
      {
        kind: "paragraph",
        text: "Liquidity / Exit now carries the evidence quality behind each published DEX score instead of treating TVL proxies, fallback rows, and retained AMM reserves as measured executable depth.",
      },
      {
        kind: "list",
        items: [
          "Reserve-based AMM simulation caps at 85, generic TVL proxies at 60, and synthetic/fallback evidence at 55.",
          "A row with provider-inaccessible deployments and no observed deployment caps at 45.",
          "Inputs without republished evidence fields and rows explicitly marked legacy remain neutral and wire-compatible.",
          "The fixed-input replay changed 18 scores and 9 grades with no NR transitions; the standalone public Liquidity Score is unchanged.",
        ],
      },
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "8.15",
    title: "Dependency scoring is deterministic across cycles and unavailable upstreams",
    date: "2026-07-12",
    effectiveAt: 1783897755,
    summary:
      "Dependency Risk now rejects unresolved graph cycles before publication, falls live-created cycles back to curated dependency sets, and scores fully unavailable upstreams through the same blend, weak-dependency penalty, and wrapper/mechanism ceilings used for partially unavailable exposure.",
    impact: [
      "Static self-links, duplicate edges, and unreviewed multi-asset cycles block report-card generation instead of relying on traversal order",
      "Live-created cycle members fall back to their current curated/manual dependency sets and are diagnosed again; an invalid fallback graph rejects snapshot publication and therefore prevents a grade-history write from that run",
      "Every unavailable upstream weight is scored at 70 inside the normal dependency blend, draws the existing 10-point weak-dependency penalty, and remains subject to wrapper or mechanism ceilings",
      "Dependency dimensions expose structured raw and normalized contributions, self-backed share, available/unavailable weights and IDs, the weak penalty, and the binding ceiling; contagion recomputation regenerates those diagnostics",
      "Fixed-input calibration changed two all-unavailable wrappers: Savings rUSD moved 39 to 36 without crossing a grade, and Zephyr Yield Share moved 51/C- to 47/D; 38 stale nonbinding ceiling labels were removed with no score effect, and no NR or dependency-edge changes occurred",
    ],
    detail: [
      {
        kind: "paragraph",
        text: "Dependency Risk now uses one scoring path for available and unavailable upstreams, and report-card publication no longer permits a dependency cycle to make results depend on traversal order.",
      },
      {
        kind: "list",
        items: [
          "Fully unavailable weights use the same explicit blend, 70-point fallback, weak-upstream penalty, and wrapper/mechanism ceilings as partially unavailable weights.",
          "Live-created cycle members fall back to curated dependency sets; an invalid fallback graph rejects the snapshot before cache or grade-history publication.",
          "Dependency dimensions now include structured contribution, availability, normalization, penalty, and ceiling diagnostics, including after contagion stress recomputation.",
          "The fixed-input all-card replay found two score changes, one expected grade crossing, 38 corrected nonbinding ceiling labels with no score effect, and no NR changes.",
        ],
      },
    ],
    commits: [],
    reconstructed: false,
  },
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
    detail: [
      {
        kind: "paragraph",
        text: "Dependency derivation now rejects self-links and represents each tracked variant as one serial wrapper claim on its parent, so displaying a parent's reserve book does not count that backing a second time.",
      },
      {
        kind: "list",
        items: [
          "Frax self-holdings remain visible in reserve composition but no longer create a FRAX-to-FRAX graph edge.",
          "Static metadata, adapter output, stored live snapshots, the canonical resolver, and graph emission all enforce the same self-link and target-validity invariants.",
          "Raw inputs now include dependency source, fallback reason, mapped live weight, and live snapshot provenance.",
          "The fixed-input all-card replay found two score changes and no grade or NR transitions.",
        ],
      },
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
    detail: [
      {
        kind: "paragraph",
        text: "Dependency Risk now falls back to curated reserve links or manual dependencies when a score-grade live reserve snapshot contains no mapped tracked-asset links at all.",
      },
      {
        kind: "list",
        items: [
          "Partial live mappings stay authoritative: unmapped live reserve remainder still counts as self-backed or non-stablecoin exposure instead of reviving older curated percentages.",
          "The fallback applies only to the all-unmapped live case, where treating the whole snapshot as self-backed can erase known upstream stablecoin dependencies.",
          ["Raw inputs keep ", { code: "dependencyFromLive" }, " true only for live-derived or explicitly live-unmapped dependency sets; curated/manual fallback dependencies report false."],
        ],
      },
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
    detail: [
      {
        kind: "paragraph",
        text: [
          "Reviewed bridge-route profiles now feed Decentralization through a penalty-only blend after CDP oracle scoring and before Mint Authority: ",
          { numeric: "min(current, 0.80 x current + 0.20 x bridge route score)" },
          ".",
        ],
      },
      {
        kind: "list",
        items: [
          [{ code: "bridgeRouteRisk" }, " profiles record route tier, summary, provenance, confidence, protocol evidence, and sources."],
          "Missing bridge-route reviews remain neutral, and strong issuer-native or canonical routes never lift a score.",
          "L2BEAT Interop data powers an advisory review queue, but live report-card scoring consumes only curated Pharos metadata.",
        ],
      },
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
    detail: [
      {
        kind: "paragraph",
        text: "Oracle-risk reviews now carry provenance and optional branch rows. When a CDP profile has branch-level oracle tiers, the Decentralization blend uses the weakest branch/profile score so multi-collateral systems are scored against their weakest verified price-feed path.",
      },
      {
        kind: "list",
        items: [
          [{ code: "oracleRisk" }, " profiles can include reviewed date, reviewer, confidence, source links, and per-branch collateral/chains context."],
          "Report-card payloads now expose an oracle setup presentation object, including inherited parent exposure for wrappers and savings variants.",
          "A warning-only coverage check and calibration report support the full CDP oracle-profile backfill and later review of the 25% blend weight.",
        ],
      },
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
    detail: [
      {
        kind: "paragraph",
        text: [
          "Crypto-backed CDP stablecoins can now carry a reviewed oracle-risk profile. When one is present, Decentralization applies a penalty-only oracle setup blend — ",
          { numeric: "min(current, 0.75 × current + 0.25 × oracle score)" },
          " — because liquidations and redemptions depend on the collateral price-feed path.",
        ],
      },
      {
        kind: "list",
        items: [
          [
            "The blend applies only to explicit ",
            { code: "oracleRisk" },
            " profiles on crypto-backed CDP assets; missing reviews and non-CDP assets are unchanged.",
          ],
          "The oracle step runs after governance and chain infrastructure, before the existing Mint Authority blend. Immutable-code CDPs are not exempt because oracle feeds remain an external dependency.",
          "Initial reviewed profiles cover USDS as a medianized delayed oracle system and BOLD as redundant feeds with failover. Other CDPs stay unchanged until reviewed oracle metadata is curated.",
        ],
      },
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
      "Mint Authority Score NR (missing or unresolved review) leaves the dimension untouched; a missing review never penalizes",
      "No separate confidence gate: the Mint Authority confidence caps (verified 100 / probable 90 / manual-review 85) already encode evidence quality inside the score",
      "111 of 368 scoreable active coins move down, none up; biggest dimension drops are mint-incident and unbounded-mint protocols (DOLA 75 to 56, reUSD 55 to 39, MIM 45 to 33, USDe 45 to 38, crvUSD 85 to 77); USDT, USDC, LUSD, and BOLD are unchanged because their governance scores already reflect their mint topology",
      "Dimension weights, the peg multiplier, and the other four dimensions are unchanged; raw inputs now expose the standalone mintAuthorityScore input",
    ],
    detail: [
      {
        kind: "paragraph",
        text: [
          "The Mint Authority Score becomes a Safety Score input: the Decentralization dimension now applies a penalty-only blend — ",
          { numeric: "min(current, 0.65 × current + 0.35 × MAS)" },
          " — so a weak privileged-mint path can drag the dimension down, while a strong one never lifts it.",
        ],
      },
      {
        kind: "list",
        items: [
          "The blend runs after the governance baseline, wrapper inheritance, and the chain-infrastructure penalty; a \"Mint authority\" detail row appears on the report card when the drag binds.",
          "Coins without a rated Mint Authority Score are unchanged — a missing or unresolved review never penalizes.",
          "No separate confidence gate: the Mint Authority confidence caps (verified 100 / probable 90 / manual-review 85) already encode evidence quality inside the score.",
          "111 of 368 scoreable active coins move down, none up; the biggest drops are mint-incident and unbounded-mint protocols, while issuers whose governance scores already reflect their mint topology are unchanged.",
        ],
      },
    ],
    commits: [],
    reconstructed: false,
  },
];
