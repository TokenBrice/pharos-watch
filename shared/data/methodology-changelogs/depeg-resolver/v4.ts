import type { MethodologyChangelogEntry } from "@shared/lib/methodology-versions/base";

export const DEPEG_RESOLVER_V4: readonly MethodologyChangelogEntry[] = [
  {
    version: "4.3",
    title: "Continuous depeg windows and reason-authoritative recovery labels",
    date: "2026-08-23",
    effectiveAt: 1787443200,
    summary:
      "Depeg onset and recovery windows now require consecutive observations, with a 1200-second continuity tolerance deliberately set above the 900-second producer cadence so ordinary scheduler jitter does not read as a coverage break, while DDR training and DDRR review classify recovery from explicit closure reasons with a legacy price fallback only for null-reason rows.",
    impact: [
      "Same-direction pending episodes reset after an observation gap greater than 1200 seconds, so a blind interval cannot backdate a confirmed onset",
      "Recovery confirmation stores both first and last qualified observations, resets after a gap greater than 1200 seconds or contradictory evidence, and keeps events open through missing data",
      "Explicit recovered-primary, recovered-dex, and recovered-native reasons define recovered labels even when native quote-domain policy stores no recovery price",
      "Direction supersession, coverage loss, orphan cleanup, and unknown explicit closures cannot enter the recovered duration corpus or DDRR recovered outcomes through a stray recovery price",
      "Legacy rows with null close reasons retain recovery-price compatibility so historical recovered labels are not erased",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.2",
    title: "Mint-posture predicates unified; mint-scoped non-inflatability recognised",
    date: "2026-08-10",
    effectiveAt: 1786314551,
    summary:
      "DDR's mint-posture tests now read shared predicates instead of per-engine literal sets, and the mint-scoped `none-resolved-mint` posture earns the weak R1 non-inflatable-supply anchor it previously fell through entirely. No resolution tier, factor weight, duration landmark, or stratum assignment changes.",
    impact: [
      "Posture set membership moved to `isFragileMintPosture` / `isUnboundedMintPosture` / `isNoPrivilegedMintPosture` / `isNoPrivilegedMintChainPosture` in shared/lib/safety-score-v9/mint-posture.ts; K1's risky-minter leg, K1's severe-surge rung and the structural-class legs all read the same source, so a future posture value is classified once instead of at each site",
      "14 wrapper assets annotated `none-resolved-mint` (sUSDe, sDAI, sGHO, scrvUSD, stUSDS, sBOLD, sDOLA, srUSD, sdUSD, said, steakUSDC, steakUSDT, yvUSDC, eEARN) now publish the R1 recovery anchor at the weak rung during an event, labelled `No privileged mint authority on this token (wrapped supply can still expand)`",
      "The strong R1 rung remains whole-of-chain only: a wrapper's parent can still print, so `none-resolved-mint` cannot satisfy the strong-anchor leg of the tier rule. Only strong anchors enter that rule, so no verdict, sealed prediction or duration stratum moves",
      "Structural-class stratification is unchanged: `none-resolved-mint` still confers no robustness of its own, matching the whole-of-chain definition in shared/types/core.ts",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.1",
    title: "Structural inputs read published Safety Score outputs",
    date: "2026-08-08",
    effectiveAt: 1786147201,
    summary:
      "DDR's mint-authority structural input now reads the published Safety Score V9 mint posture band instead of the retired standalone Mint Authority band. Prediction weights, factor rules, and exit thresholds are unchanged.",
    impact: [
      "K1's risky-minter test reads the published V9 mint posture band; the concentrated and exposed bands stay the risky set, so the rule is unchanged and only its input moved engines",
      "A run with no installed V9 publication derives the band from the curated authority posture instead, so a degraded or held publication cannot silently drop K1's band leg; an installed publication is authoritative, including when it publishes no band for an asset",
      "K5 inputs are unchanged: it already read published Safety Score outputs and continues to do so",
      "No factor weights, severity bands, duration landmarks, or incident-lifecycle rules change",
    ],
    commits: [],
    reconstructed: false,
  },
  {
    version: "4.0",
    title: "DDR v4 Methodology Contract",
    date: "2026-07-30",
    effectiveAt: 1785427200,
    summary:
      "DDR v4 updates terminality signals, duration landmarks, incident lifecycle grouping, support rules, and reviewer audit metadata for new predictions.",
    impact: [
      "Issuer wind-down evidence and measured exit or supply stress provide earlier terminality context, while backing concentration is gated by mechanism and observed impairment",
      "Duration labels follow canonical incident grouping, typical ranges use the 15th-85th percentiles, and comparable histories are deduplicated by coin",
      "Recovered pre-lock incidents can close and resurrect within the merge window, while regime-escalating tails begin a separate incident and prediction",
      "DDRR review rows expose repaired and split lineage and publish expected-versus-observed horizon calibration alongside realized outcomes",
    ],
    commits: [],
    reconstructed: false,
  },
];
